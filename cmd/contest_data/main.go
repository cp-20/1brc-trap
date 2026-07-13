package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	progressbar "github.com/cp-20/1blc-trap/internal/progress"
	"github.com/klauspost/compress/zstd"
)

type manifest struct {
	SchemaVersion     int        `json:"schemaVersion"`
	ContestID         string     `json:"contestId"`
	GeneratedAt       string     `json:"generatedAt"`
	GeneratorRevision string     `json:"generatorRevision"`
	Artifacts         []artifact `json:"artifacts"`
}

type artifact struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Label              string `json:"label"`
	ObjectKey          string `json:"objectKey"`
	Rows               int64  `json:"rows"`
	CompressedBytes    int64  `json:"compressedBytes"`
	UncompressedBytes  int64  `json:"uncompressedBytes"`
	CompressedSHA256   string `json:"compressedSha256"`
	UncompressedSHA256 string `json:"uncompressedSha256"`
	IsPublic           bool   `json:"isPublic"`
	localPath          string
}

type runnerDownloads struct {
	GeneratedAt string                    `json:"generatedAt"`
	ExpiresAt   string                    `json:"expiresAt"`
	Files       map[string]runnerDownload `json:"files"`
}

type runnerDownload struct {
	URL              string `json:"url"`
	SHA256           string `json:"sha256"`
	CompressedSHA256 string `json:"compressedSha256"`
}

var runnerFileNames = [...]string{"public.csv", "public.expected", "private.csv", "private.expected"}

type uploadProgressListener struct {
	bar *progressbar.Bar
}

func (listener uploadProgressListener) OnObjectBytesTransferred(_ context.Context, event *transfermanager.ObjectBytesTransferredEvent) {
	listener.bar.Set(event.BytesTransferred)
}

const progressHeartbeat = 10 * time.Second

type progress struct {
	out            io.Writer
	current, total int
}

func newProgress(out io.Writer, total int) *progress {
	return &progress{out: out, total: total}
}

func (p *progress) run(label string, work func() error) error {
	return p.runWithHeartbeat(label, true, work)
}

func (p *progress) runLive(label string, work func() error) error {
	return p.runWithHeartbeat(label, false, work)
}

func (p *progress) runBar(label string, total int64, unit string, work func(*progressbar.Bar) error) error {
	return p.runLive(label, func() error {
		bar := progressbar.New(p.out, total, unit)
		err := work(bar)
		bar.Done(err == nil)
		return err
	})
}

func (p *progress) runWithHeartbeat(label string, showHeartbeat bool, work func() error) error {
	p.current++
	step := p.current
	started := time.Now()
	fmt.Fprintf(p.out, "[%d/%d] %s\n", step, p.total, label)

	done := make(chan struct{})
	var heartbeat sync.WaitGroup
	if showHeartbeat {
		heartbeat.Add(1)
		go func() {
			defer heartbeat.Done()
			ticker := time.NewTicker(progressHeartbeat)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					fmt.Fprintf(p.out, "[%d/%d] still running: %s (%s elapsed)\n", step, p.total, label, time.Since(started).Round(time.Second))
				case <-done:
					return
				}
			}
		}()
	}

	err := work()
	close(done)
	heartbeat.Wait()
	status := "done"
	if err != nil {
		status = "failed"
	}
	fmt.Fprintf(p.out, "[%d/%d] %s: %s (%s)\n", step, p.total, status, label, time.Since(started).Round(time.Millisecond))
	return err
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "generate":
		err = generate(os.Args[2:])
	case "upload":
		err = upload(os.Args[2:])
	case "presign-runner":
		err = presignRunner(os.Args[2:])
	case "download":
		err = download(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: contest_data <generate|upload|presign-runner|download> [options]")
	os.Exit(2)
}

func generate(args []string) error {
	flags := flag.NewFlagSet("generate", flag.ContinueOnError)
	outputDir := flags.String("output", "data/contest", "output directory")
	runnerDir := flags.String("runner-dir", "", "optional directory populated for a local runner")
	contestID := flags.String("contest-id", "1brc-trap-2026", "contest identifier")
	publicRows := flags.Int64("public-rows", 1_000_000_000, "public dataset row count")
	privateRows := flags.Int64("private-rows", 1_000_000_000, "private dataset row count")
	publicSeed := flags.Int64("public-seed", 1_000_000_007, "public random seed")
	privateSeed := flags.Int64("private-seed", 2_000_000_011, "private random seed")
	tierText := flags.String("tiers", "1000000,10000000,100000000,1000000000", "comma-separated public tiers")
	threads := flags.Int("threads", runtime.NumCPU(), "expected generator threads")
	revision := flags.String("revision", gitRevision(), "generator revision")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *publicRows <= 0 || *privateRows <= 0 || *threads <= 0 {
		return errors.New("row counts and threads must be positive")
	}
	tiers, err := parseTiers(*tierText, *publicRows)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*outputDir, 0o755); err != nil {
		return err
	}
	if *runnerDir != "" {
		if err := os.MkdirAll(*runnerDir, 0o755); err != nil {
			return err
		}
	}
	runnerLabel := *runnerDir
	if runnerLabel == "" {
		runnerLabel = "disabled"
	}
	fmt.Fprintf(
		os.Stderr,
		"generate contest=%s public_rows=%d private_rows=%d tiers=%v threads=%d output=%s runner=%s\n",
		*contestID, *publicRows, *privateRows, tiers, *threads, *outputDir, runnerLabel,
	)
	steps := 8*len(tiers) + 9
	if *runnerDir != "" {
		steps++
	}
	progress := newProgress(os.Stderr, steps)

	publicFull := filepath.Join(*outputDir, fmt.Sprintf("public-%d.csv", *publicRows))
	privateFull := filepath.Join(*outputDir, fmt.Sprintf("private-%d.csv", *privateRows))
	if err := progress.runLive(fmt.Sprintf("generate public dataset (%d rows)", *publicRows), func() error {
		return runGo("./cmd/traq_data", "-n", strconv.FormatInt(*publicRows, 10), "-seed", strconv.FormatInt(*publicSeed, 10), "-o", publicFull, "-progress")
	}); err != nil {
		return fmt.Errorf("generate public dataset: %w", err)
	}
	if err := progress.runLive(fmt.Sprintf("generate private dataset (%d rows)", *privateRows), func() error {
		return runGo("./cmd/traq_data", "-n", strconv.FormatInt(*privateRows, 10), "-seed", strconv.FormatInt(*privateSeed, 10), "-o", privateFull, "-progress")
	}); err != nil {
		return fmt.Errorf("generate private dataset: %w", err)
	}

	tierFiles := make(map[int64]string, len(tiers))
	for _, rows := range tiers {
		path := filepath.Join(*outputDir, fmt.Sprintf("public-%d.csv", rows))
		if rows == *publicRows {
			path = publicFull
		} else {
			if err := progress.runBar(fmt.Sprintf("create public prefix (%d rows)", rows), rows, "rows", func(bar *progressbar.Bar) error {
				return writePrefix(publicFull, path, rows, bar.Set)
			}); err != nil {
				return fmt.Errorf("make %d row prefix: %w", rows, err)
			}
		}
		tierFiles[rows] = path
	}

	items := make([]artifact, 0, len(tiers)*2+2)
	for _, rows := range tiers {
		inputPath := tierFiles[rows]
		expectedPath := strings.TrimSuffix(inputPath, ".csv") + ".expected"
		if err := progress.runLive(fmt.Sprintf("calculate public expected output (%d rows)", rows), func() error {
			return runExpected(inputPath, expectedPath, *threads)
		}); err != nil {
			return fmt.Errorf("expected for %d rows: %w", rows, err)
		}
		label := tierLabel(rows)
		inputArtifact, err := packageArtifact(progress, *contestID, fmt.Sprintf("public-%s-input", label), "input", "Public "+strings.ToUpper(label)+" input", rows, true, inputPath)
		if err != nil {
			return err
		}
		expectedArtifact, err := packageArtifact(progress, *contestID, fmt.Sprintf("public-%s-expected", label), "expected", "Public "+strings.ToUpper(label)+" expected", rows, true, expectedPath)
		if err != nil {
			return err
		}
		items = append(items, inputArtifact, expectedArtifact)
	}

	privateExpected := strings.TrimSuffix(privateFull, ".csv") + ".expected"
	if err := progress.runLive(fmt.Sprintf("calculate private expected output (%d rows)", *privateRows), func() error {
		return runExpected(privateFull, privateExpected, *threads)
	}); err != nil {
		return fmt.Errorf("private expected: %w", err)
	}
	privateInputArtifact, err := packageArtifact(progress, *contestID, "private-1b-input", "input", "Private 1B input", *privateRows, false, privateFull)
	if err != nil {
		return err
	}
	privateExpectedArtifact, err := packageArtifact(progress, *contestID, "private-1b-expected", "expected", "Private 1B expected", *privateRows, false, privateExpected)
	if err != nil {
		return err
	}
	items = append(items, privateInputArtifact, privateExpectedArtifact)

	data := manifest{
		SchemaVersion:     1,
		ContestID:         *contestID,
		GeneratedAt:       time.Now().UTC().Format(time.RFC3339),
		GeneratorRevision: *revision,
		Artifacts:         items,
	}
	manifestPath := filepath.Join(*outputDir, "manifest.json")
	if err := progress.run("write manifest", func() error {
		return writeJSON(manifestPath, data)
	}); err != nil {
		return err
	}

	if *runnerDir != "" {
		publicExpected := strings.TrimSuffix(tierFiles[tiers[len(tiers)-1]], ".csv") + ".expected"
		runnerFiles := map[string]string{
			publicFull:      "public.csv",
			publicExpected:  "public.expected",
			privateFull:     "private.csv",
			privateExpected: "private.expected",
		}
		var runnerBytes int64
		for source := range runnerFiles {
			info, err := os.Stat(source)
			if err != nil {
				return err
			}
			runnerBytes += info.Size()
		}
		if err := progress.runBar("prepare runner files", runnerBytes, "bytes", func(bar *progressbar.Bar) error {
			for source, name := range runnerFiles {
				if err := hardlinkOrCopy(source, filepath.Join(*runnerDir, name), bar); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "generate complete: manifest=%s runner=%s\n", manifestPath, runnerLabel)
	return nil
}

func packageArtifact(progress *progress, contestID, id, kind, label string, rows int64, public bool, path string) (artifact, error) {
	sourceInfo, err := os.Stat(path)
	if err != nil {
		return artifact{}, err
	}
	compressedPath := path + ".zst"
	if err := progress.runBar("compress "+label, sourceInfo.Size(), "bytes", func(bar *progressbar.Bar) error {
		return compress(path, compressedPath, bar)
	}); err != nil {
		return artifact{}, fmt.Errorf("compress %s: %w", path, err)
	}
	var uncompressedSize int64
	var uncompressedHash string
	if err := progress.runBar("checksum "+label+" source", sourceInfo.Size(), "bytes", func(bar *progressbar.Bar) error {
		var err error
		uncompressedSize, uncompressedHash, err = fileInfo(path, bar)
		return err
	}); err != nil {
		return artifact{}, err
	}
	compressedInfo, err := os.Stat(compressedPath)
	if err != nil {
		return artifact{}, err
	}
	var compressedSize int64
	var compressedHash string
	if err := progress.runBar("checksum "+label+" archive", compressedInfo.Size(), "bytes", func(bar *progressbar.Bar) error {
		var err error
		compressedSize, compressedHash, err = fileInfo(compressedPath, bar)
		return err
	}); err != nil {
		return artifact{}, err
	}
	scope := "private"
	if public {
		scope = "public"
	}
	return artifact{
		ID:                 id,
		Kind:               kind,
		Label:              label,
		ObjectKey:          fmt.Sprintf("datasets/%s/%s/%s", contestID, scope, filepath.Base(compressedPath)),
		Rows:               rows,
		CompressedBytes:    compressedSize,
		UncompressedBytes:  uncompressedSize,
		CompressedSHA256:   compressedHash,
		UncompressedSHA256: uncompressedHash,
		IsPublic:           public,
		localPath:          compressedPath,
	}, nil
}

func upload(args []string) error {
	flags, manifestPath, bucket, endpoint, accessKey, secretKey, createBucket := objectFlags("upload", args)
	if err := flags; err != nil {
		return err
	}
	data, err := readManifest(manifestPath)
	if err != nil {
		return err
	}
	client, err := s3Client(endpoint, accessKey, secretKey)
	if err != nil {
		return err
	}
	ctx := context.Background()
	if createBucket {
		fmt.Fprintf(os.Stderr, "ensure bucket exists: %s\n", bucket)
		_, _ = client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	}
	fmt.Fprintf(os.Stderr, "upload manifest=%s bucket=%s endpoint=%s artifacts=%d\n", manifestPath, bucket, endpoint, len(data.Artifacts))
	progress := newProgress(os.Stderr, 2*len(data.Artifacts))
	transfer := transfermanager.New(client)
	base := filepath.Dir(manifestPath)
	for _, item := range data.Artifacts {
		path := filepath.Join(base, filepath.Base(item.ObjectKey))
		if err := progress.runBar("verify "+item.ObjectKey, item.CompressedBytes, "bytes", func(bar *progressbar.Bar) error {
			size, digest, err := fileInfo(path, bar)
			if err != nil {
				return err
			}
			if size != item.CompressedBytes || digest != item.CompressedSHA256 {
				return fmt.Errorf("local artifact does not match manifest: %s", item.ObjectKey)
			}
			return nil
		}); err != nil {
			return err
		}
		if err := progress.runBar("upload "+item.ObjectKey, item.CompressedBytes, "bytes", func(bar *progressbar.Bar) error {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			_, uploadErr := transfer.UploadObject(ctx, &transfermanager.UploadObjectInput{
				Bucket:      aws.String(bucket),
				Key:         aws.String(item.ObjectKey),
				Body:        file,
				ContentType: aws.String("application/zstd"),
			}, func(options *transfermanager.Options) {
				options.ObjectProgressListeners.Register(uploadProgressListener{bar: bar})
			})
			closeErr := file.Close()
			if uploadErr != nil {
				return fmt.Errorf("upload %s: %w", item.ObjectKey, uploadErr)
			}
			return closeErr
		}); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "upload complete: %d artifacts\n", len(data.Artifacts))
	return nil
}

func presignRunner(args []string) error {
	flags := flag.NewFlagSet("presign-runner", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	outputPath := flags.String("output", "data/contest/runner-downloads.json", "output path")
	bucket := flags.String("bucket", "", "bucket name")
	endpoint := flags.String("endpoint", os.Getenv("R2_ENDPOINT"), "R2 S3 endpoint")
	accountID := flags.String("account-id", os.Getenv("R2_ACCOUNT_ID"), "R2 account ID")
	accessKeyDefault, secretKeyDefault := r2WriteCredentials()
	accessKey := flags.String("access-key", accessKeyDefault, "access key")
	secretKey := flags.String("secret-key", secretKeyDefault, "secret key")
	expires := flags.Duration("expires", 24*time.Hour, "presigned URL lifetime")
	if err := flags.Parse(args); err != nil {
		return err
	}
	resolvedEndpoint, err := resolveR2Endpoint(*endpoint, *accountID)
	if err != nil {
		return err
	}
	if *bucket == "" || *accessKey == "" || *secretKey == "" {
		return errors.New("bucket, access-key and secret-key are required")
	}
	if *expires < time.Second || *expires > 7*24*time.Hour {
		return errors.New("expires must be between 1s and 168h")
	}
	data, err := readManifest(*manifestPath)
	if err != nil {
		return err
	}
	artifacts, err := selectRunnerArtifacts(data)
	if err != nil {
		return err
	}
	client, err := s3Client(resolvedEndpoint, *accessKey, *secretKey)
	if err != nil {
		return err
	}
	presigner := s3.NewPresignClient(client)
	now := time.Now().UTC()
	downloads := runnerDownloads{
		GeneratedAt: now.Format(time.RFC3339),
		ExpiresAt:   now.Add(*expires).Format(time.RFC3339),
		Files:       make(map[string]runnerDownload, len(artifacts)),
	}
	for _, name := range runnerFileNames {
		item := artifacts[name]
		request, err := presigner.PresignGetObject(context.Background(), &s3.GetObjectInput{
			Bucket: aws.String(*bucket),
			Key:    aws.String(item.ObjectKey),
		}, s3.WithPresignExpires(*expires))
		if err != nil {
			return fmt.Errorf("presign %s: %w", item.ObjectKey, err)
		}
		downloads.Files[name] = runnerDownload{
			URL:              request.URL,
			SHA256:           item.UncompressedSHA256,
			CompressedSHA256: item.CompressedSHA256,
		}
	}
	if err := os.MkdirAll(filepath.Dir(*outputPath), 0o755); err != nil {
		return err
	}
	if err := writeJSONMode(*outputPath, downloads, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "presigned %d runner downloads until %s: %s\n", len(downloads.Files), downloads.ExpiresAt, *outputPath)
	return nil
}

func selectRunnerArtifacts(data manifest) (map[string]artifact, error) {
	rowsByScope := map[bool]int64{}
	for _, item := range data.Artifacts {
		if item.Kind == "input" && item.Rows > rowsByScope[item.IsPublic] {
			rowsByScope[item.IsPublic] = item.Rows
		}
	}
	if rowsByScope[true] == 0 || rowsByScope[false] == 0 {
		return nil, errors.New("manifest must contain public and private input artifacts")
	}
	targets := []struct {
		name   string
		kind   string
		public bool
		rows   int64
	}{
		{name: "public.csv", kind: "input", public: true, rows: rowsByScope[true]},
		{name: "public.expected", kind: "expected", public: true, rows: rowsByScope[true]},
		{name: "private.csv", kind: "input", public: false, rows: rowsByScope[false]},
		{name: "private.expected", kind: "expected", public: false, rows: rowsByScope[false]},
	}
	selected := make(map[string]artifact, len(targets))
	for _, target := range targets {
		for _, item := range data.Artifacts {
			if item.Kind == target.kind && item.IsPublic == target.public && item.Rows == target.rows {
				selected[target.name] = item
				break
			}
		}
		if selected[target.name].ObjectKey == "" {
			return nil, fmt.Errorf("manifest does not contain runner artifact %s", target.name)
		}
	}
	return selected, nil
}

func download(args []string) error {
	flags := flag.NewFlagSet("download", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	outputDir := flags.String("output", "data/contest/download", "output directory")
	bucket := flags.String("bucket", "", "bucket name")
	endpoint := flags.String("endpoint", os.Getenv("R2_ENDPOINT"), "R2 S3 endpoint")
	accountID := flags.String("account-id", os.Getenv("R2_ACCOUNT_ID"), "R2 account ID")
	accessKey := flags.String("access-key", os.Getenv("AWS_ACCESS_KEY_ID"), "access key")
	secretKey := flags.String("secret-key", os.Getenv("AWS_SECRET_ACCESS_KEY"), "secret key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	resolvedEndpoint, err := resolveR2Endpoint(*endpoint, *accountID)
	if err != nil {
		return err
	}
	*endpoint = resolvedEndpoint
	if *bucket == "" || *accessKey == "" || *secretKey == "" {
		return errors.New("bucket, access-key and secret-key are required")
	}
	data, err := readManifest(*manifestPath)
	if err != nil {
		return err
	}
	client, err := s3Client(*endpoint, *accessKey, *secretKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*outputDir, 0o755); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "download manifest=%s bucket=%s endpoint=%s artifacts=%d output=%s\n", *manifestPath, *bucket, *endpoint, len(data.Artifacts), *outputDir)
	progress := newProgress(os.Stderr, len(data.Artifacts))
	transfer := transfermanager.New(client)
	for _, item := range data.Artifacts {
		if err := progress.run(fmt.Sprintf("download and verify %s (%d bytes)", item.ObjectKey, item.CompressedBytes), func() error {
			path := filepath.Join(*outputDir, filepath.Base(item.ObjectKey))
			file, err := os.Create(path)
			if err != nil {
				return err
			}
			_, downloadErr := transfer.DownloadObject(context.Background(), &transfermanager.DownloadObjectInput{
				Bucket: aws.String(*bucket), Key: aws.String(item.ObjectKey), WriterAt: file,
			})
			closeErr := file.Close()
			if downloadErr != nil {
				return downloadErr
			}
			if closeErr != nil {
				return closeErr
			}
			_, hash, err := fileInfo(path, nil)
			if err != nil || hash != item.CompressedSHA256 {
				return fmt.Errorf("checksum mismatch for %s", item.ObjectKey)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "download complete: %d artifacts\n", len(data.Artifacts))
	return nil
}

func objectFlags(name string, args []string) (error, string, string, string, string, string, bool) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	bucket := flags.String("bucket", "", "bucket name")
	endpoint := flags.String("endpoint", os.Getenv("R2_ENDPOINT"), "R2 S3 endpoint")
	accountID := flags.String("account-id", os.Getenv("R2_ACCOUNT_ID"), "R2 account ID")
	accessKeyDefault, secretKeyDefault := r2WriteCredentials()
	accessKey := flags.String("access-key", accessKeyDefault, "access key")
	secretKey := flags.String("secret-key", secretKeyDefault, "secret key")
	createBucket := flags.Bool("create-bucket", false, "create bucket when it does not exist")
	if err := flags.Parse(args); err != nil {
		return err, "", "", "", "", "", false
	}
	resolvedEndpoint, err := resolveR2Endpoint(*endpoint, *accountID)
	if err != nil {
		return err, "", "", "", "", "", false
	}
	*endpoint = resolvedEndpoint
	if *bucket == "" || *accessKey == "" || *secretKey == "" {
		return errors.New("bucket, access-key and secret-key are required"), "", "", "", "", "", false
	}
	return nil, *manifestPath, *bucket, *endpoint, *accessKey, *secretKey, *createBucket
}

func r2WriteCredentials() (string, string) {
	accessKey := os.Getenv("R2_WRITE_ACCESS_KEY_ID")
	if accessKey == "" {
		accessKey = os.Getenv("AWS_ACCESS_KEY_ID")
	}
	secretKey := os.Getenv("R2_WRITE_SECRET_ACCESS_KEY")
	if secretKey == "" {
		secretKey = os.Getenv("AWS_SECRET_ACCESS_KEY")
	}
	return accessKey, secretKey
}

func resolveR2Endpoint(endpoint, accountID string) (string, error) {
	if endpoint != "" {
		return strings.TrimRight(endpoint, "/"), nil
	}
	if accountID == "" {
		return "", errors.New("R2 endpoint is required: set --endpoint/R2_ENDPOINT or --account-id/R2_ACCOUNT_ID")
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID), nil
}

func s3Client(endpoint, accessKey, secretKey string) (*s3.Client, error) {
	options := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	}
	configuration, err := awsconfig.LoadDefaultConfig(context.Background(), options...)
	if err != nil {
		return nil, err
	}
	return s3.NewFromConfig(configuration, func(options *s3.Options) {
		if endpoint != "" {
			options.BaseEndpoint = aws.String(endpoint)
			options.UsePathStyle = true
		}
	}), nil
}

func runGo(pkg string, args ...string) error {
	commandArgs := append([]string{"run", pkg}, args...)
	command := exec.Command("go", commandArgs...)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	return command.Run()
}

func runExpected(input, output string, threads int) error {
	return runGo("./optimized/go", "-i", input, "-o", output, "-t", strconv.Itoa(threads), "-profile", "-progress")
}

func writePrefix(source, destination string, rows int64, report func(int64)) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	writer := bufio.NewWriterSize(output, 4*1024*1024)
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 128*1024), 1024*1024)
	var lines int64
	nextReport := int64(100_000)
	for scanner.Scan() {
		if lines > rows {
			break
		}
		if _, err := writer.WriteString(scanner.Text() + "\n"); err != nil {
			return err
		}
		lines++
		dataRows := lines - 1
		if report != nil && dataRows >= nextReport {
			report(dataRows)
			nextReport += 100_000
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if lines != rows+1 {
		return fmt.Errorf("source ended after %d data rows", lines-1)
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	return output.Close()
}

func compress(source, destination string, progress *progressbar.Bar) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	encoder, err := zstd.NewWriter(output, zstd.WithEncoderLevel(zstd.SpeedBetterCompression), zstd.WithEncoderConcurrency(runtime.NumCPU()))
	if err != nil {
		return err
	}
	var reader io.Reader = input
	if progress != nil {
		reader = progress.Reader(input)
	}
	_, copyErr := io.CopyBuffer(encoder, reader, make([]byte, 4*1024*1024))
	closeEncoderErr := encoder.Close()
	closeOutputErr := output.Close()
	return errors.Join(copyErr, closeEncoderErr, closeOutputErr)
}

func fileInfo(path string, progress *progressbar.Bar) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	var reader io.Reader = file
	if progress != nil {
		reader = progress.Reader(file)
	}
	written, err := io.CopyBuffer(hash, reader, make([]byte, 4*1024*1024))
	if err != nil {
		return 0, "", err
	}
	return written, hex.EncodeToString(hash.Sum(nil)), nil
}

func hardlinkOrCopy(source, destination string, progress *progressbar.Bar) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	_ = os.Remove(destination)
	if err := os.Link(source, destination); err == nil {
		if progress != nil {
			progress.Add(info.Size())
		}
		return nil
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	var reader io.Reader = input
	if progress != nil {
		reader = progress.Reader(input)
	}
	_, copyErr := io.CopyBuffer(output, reader, make([]byte, 4*1024*1024))
	return errors.Join(copyErr, output.Close())
}

func parseTiers(value string, maximum int64) ([]int64, error) {
	seen := make(map[int64]struct{})
	for _, raw := range strings.Split(value, ",") {
		rows, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || rows <= 0 || rows > maximum {
			return nil, fmt.Errorf("invalid tier: %s", raw)
		}
		seen[rows] = struct{}{}
	}
	seen[maximum] = struct{}{}
	result := make([]int64, 0, len(seen))
	for rows := range seen {
		result = append(result, rows)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func tierLabel(rows int64) string {
	switch rows {
	case 1_000_000:
		return "1m"
	case 10_000_000:
		return "10m"
	case 100_000_000:
		return "100m"
	case 1_000_000_000:
		return "1b"
	default:
		return strconv.FormatInt(rows, 10)
	}
}

func readManifest(path string) (manifest, error) {
	var data manifest
	content, err := os.ReadFile(path)
	if err != nil {
		return data, err
	}
	err = json.Unmarshal(content, &data)
	return data, err
}

func writeJSON(path string, value any) error {
	return writeJSONMode(path, value, 0o644)
}

func writeJSONMode(path string, value any, mode os.FileMode) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	_, writeErr := file.Write(append(content, '\n'))
	return errors.Join(writeErr, file.Close())
}

func gitRevision() string {
	output, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(output))
}
