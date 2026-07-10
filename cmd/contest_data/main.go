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
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
	case "download":
		err = download(os.Args[2:])
	case "push-runner":
		err = pushRunner(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: contest_data <generate|upload|download|push-runner> [options]")
	os.Exit(2)
}

func generate(args []string) error {
	flags := flag.NewFlagSet("generate", flag.ContinueOnError)
	outputDir := flags.String("output", "data/contest", "output directory")
	runnerDir := flags.String("runner-dir", "data/local", "directory populated for the local/remote runner")
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
	if err := os.MkdirAll(*runnerDir, 0o755); err != nil {
		return err
	}

	publicFull := filepath.Join(*outputDir, fmt.Sprintf("public-%d.csv", *publicRows))
	privateFull := filepath.Join(*outputDir, fmt.Sprintf("private-%d.csv", *privateRows))
	if err := runGo("./cmd/traq_data", "-n", strconv.FormatInt(*publicRows, 10), "-seed", strconv.FormatInt(*publicSeed, 10), "-o", publicFull); err != nil {
		return fmt.Errorf("generate public dataset: %w", err)
	}
	if err := runGo("./cmd/traq_data", "-n", strconv.FormatInt(*privateRows, 10), "-seed", strconv.FormatInt(*privateSeed, 10), "-o", privateFull); err != nil {
		return fmt.Errorf("generate private dataset: %w", err)
	}

	tierFiles := make(map[int64]string, len(tiers))
	for _, rows := range tiers {
		path := filepath.Join(*outputDir, fmt.Sprintf("public-%d.csv", rows))
		if rows == *publicRows {
			path = publicFull
		} else if err := writePrefix(publicFull, path, rows); err != nil {
			return fmt.Errorf("make %d row prefix: %w", rows, err)
		}
		tierFiles[rows] = path
	}

	items := make([]artifact, 0, len(tiers)*2+2)
	for _, rows := range tiers {
		inputPath := tierFiles[rows]
		expectedPath := strings.TrimSuffix(inputPath, ".csv") + ".expected"
		if err := runExpected(inputPath, expectedPath, *threads); err != nil {
			return fmt.Errorf("expected for %d rows: %w", rows, err)
		}
		label := tierLabel(rows)
		inputArtifact, err := packageArtifact(*contestID, fmt.Sprintf("public-%s-input", label), "input", "Public "+strings.ToUpper(label)+" input", rows, true, inputPath)
		if err != nil {
			return err
		}
		expectedArtifact, err := packageArtifact(*contestID, fmt.Sprintf("public-%s-expected", label), "expected", "Public "+strings.ToUpper(label)+" expected", rows, true, expectedPath)
		if err != nil {
			return err
		}
		items = append(items, inputArtifact, expectedArtifact)
	}

	privateExpected := strings.TrimSuffix(privateFull, ".csv") + ".expected"
	if err := runExpected(privateFull, privateExpected, *threads); err != nil {
		return fmt.Errorf("private expected: %w", err)
	}
	privateInputArtifact, err := packageArtifact(*contestID, "private-1b-input", "input", "Private 1B input", *privateRows, false, privateFull)
	if err != nil {
		return err
	}
	privateExpectedArtifact, err := packageArtifact(*contestID, "private-1b-expected", "expected", "Private 1B expected", *privateRows, false, privateExpected)
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
	if err := writeJSON(manifestPath, data); err != nil {
		return err
	}

	publicExpected := strings.TrimSuffix(tierFiles[tiers[len(tiers)-1]], ".csv") + ".expected"
	for source, name := range map[string]string{
		publicFull:      "public.csv",
		publicExpected:  "public.expected",
		privateFull:     "private.csv",
		privateExpected: "private.expected",
	} {
		if err := hardlinkOrCopy(source, filepath.Join(*runnerDir, name)); err != nil {
			return err
		}
	}
	fmt.Printf("generated %s and runner files in %s\n", manifestPath, *runnerDir)
	return nil
}

func packageArtifact(contestID, id, kind, label string, rows int64, public bool, path string) (artifact, error) {
	compressedPath := path + ".zst"
	if err := compress(path, compressedPath); err != nil {
		return artifact{}, fmt.Errorf("compress %s: %w", path, err)
	}
	uncompressedSize, uncompressedHash, err := fileInfo(path)
	if err != nil {
		return artifact{}, err
	}
	compressedSize, compressedHash, err := fileInfo(compressedPath)
	if err != nil {
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
		_, _ = client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	}
	uploader := manager.NewUploader(client)
	base := filepath.Dir(manifestPath)
	for _, item := range data.Artifacts {
		path := filepath.Join(base, filepath.Base(item.ObjectKey))
		size, digest, err := fileInfo(path)
		if err != nil {
			return err
		}
		if size != item.CompressedBytes || digest != item.CompressedSHA256 {
			return fmt.Errorf("local artifact does not match manifest: %s", item.ObjectKey)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, uploadErr := uploader.Upload(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(bucket),
			Key:         aws.String(item.ObjectKey),
			Body:        file,
			ContentType: aws.String("application/zstd"),
		})
		closeErr := file.Close()
		if uploadErr != nil {
			return fmt.Errorf("upload %s: %w", item.ObjectKey, uploadErr)
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Printf("uploaded %s\n", item.ObjectKey)
	}
	return nil
}

func download(args []string) error {
	flags := flag.NewFlagSet("download", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	outputDir := flags.String("output", "data/contest/download", "output directory")
	bucket := flags.String("bucket", "", "bucket name")
	endpoint := flags.String("endpoint", "", "S3 endpoint; empty uses Cloudflare R2 account endpoint")
	accountID := flags.String("account-id", "", "R2 account ID")
	accessKey := flags.String("access-key", os.Getenv("AWS_ACCESS_KEY_ID"), "access key")
	secretKey := flags.String("secret-key", os.Getenv("AWS_SECRET_ACCESS_KEY"), "secret key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *endpoint == "" && *accountID != "" {
		*endpoint = fmt.Sprintf("https://%s.r2.cloudflarestorage.com", *accountID)
	}
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
	downloader := manager.NewDownloader(client)
	for _, item := range data.Artifacts {
		path := filepath.Join(*outputDir, filepath.Base(item.ObjectKey))
		file, err := os.Create(path)
		if err != nil {
			return err
		}
		_, downloadErr := downloader.Download(context.Background(), file, &s3.GetObjectInput{
			Bucket: aws.String(*bucket), Key: aws.String(item.ObjectKey),
		})
		closeErr := file.Close()
		if downloadErr != nil {
			return downloadErr
		}
		if closeErr != nil {
			return closeErr
		}
		_, hash, err := fileInfo(path)
		if err != nil || hash != item.CompressedSHA256 {
			return fmt.Errorf("checksum mismatch for %s", item.ObjectKey)
		}
		fmt.Printf("downloaded %s\n", item.ObjectKey)
	}
	return nil
}

func pushRunner(args []string) error {
	flags := flag.NewFlagSet("push-runner", flag.ContinueOnError)
	source := flags.String("source", "data/local", "runner data directory")
	target := flags.String("target", "", "SSH target, e.g. ubuntu@example.com")
	remoteDir := flags.String("remote-dir", "/var/lib/1brc/data", "remote data directory")
	identity := flags.String("identity", "", "SSH identity file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *target == "" {
		return errors.New("target is required")
	}
	remoteUser, _, found := strings.Cut(*target, "@")
	if !found || remoteUser == "" || strings.ContainsAny(remoteUser, " /\\\t\r\n") {
		return errors.New("target must include a safe SSH username, e.g. ubuntu@example.com")
	}
	sshArgs := []string{}
	if *identity != "" {
		sshArgs = append(sshArgs, "-i", *identity)
	}
	mkdirArgs := append(
		append([]string{}, sshArgs...),
		*target, "sudo", "install", "-d", "-m", "0755", "-o", remoteUser, "-g", remoteUser, *remoteDir,
	)
	if output, err := exec.Command("ssh", mkdirArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("remote mkdir: %w: %s", err, output)
	}
	rsyncArgs := []string{"--archive", "--partial", "--append-verify", "--human-readable"}
	if len(sshArgs) > 0 {
		rsyncArgs = append(rsyncArgs, "-e", "ssh "+strings.Join(sshArgs, " "))
	}
	rsyncArgs = append(rsyncArgs, filepath.Clean(*source)+string(os.PathSeparator), *target+":"+*remoteDir+"/")
	command := exec.Command("rsync", rsyncArgs...)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		return err
	}
	files := []string{"public.csv", "public.expected", "private.csv", "private.expected"}
	wanted := make(map[string]string, len(files))
	remotePaths := make([]string, 0, len(files))
	for _, name := range files {
		_, digest, err := fileInfo(filepath.Join(*source, name))
		if err != nil {
			return fmt.Errorf("checksum local %s: %w", name, err)
		}
		wanted[name] = digest
		remotePaths = append(remotePaths, filepath.Join(*remoteDir, name))
	}
	checksumArgs := append(append(append([]string{}, sshArgs...), *target, "sha256sum"), remotePaths...)
	output, err := exec.Command("ssh", checksumArgs...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("remote checksum: %w: %s", err, output)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) != len(files) {
		return fmt.Errorf("remote checksum returned %d lines, expected %d", len(lines), len(files))
	}
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return fmt.Errorf("invalid remote checksum output: %q", line)
		}
		name := filepath.Base(strings.TrimPrefix(fields[1], "*"))
		if wanted[name] == "" || fields[0] != wanted[name] {
			return fmt.Errorf("remote checksum mismatch for %s", name)
		}
	}
	fmt.Print(string(output))
	return nil
}

func objectFlags(name string, args []string) (error, string, string, string, string, string, bool) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	bucket := flags.String("bucket", "", "bucket name")
	endpoint := flags.String("endpoint", "", "S3 endpoint")
	accountID := flags.String("account-id", "", "R2 account ID")
	accessKey := flags.String("access-key", os.Getenv("AWS_ACCESS_KEY_ID"), "access key")
	secretKey := flags.String("secret-key", os.Getenv("AWS_SECRET_ACCESS_KEY"), "secret key")
	createBucket := flags.Bool("create-bucket", false, "create bucket when it does not exist")
	if err := flags.Parse(args); err != nil {
		return err, "", "", "", "", "", false
	}
	if *endpoint == "" && *accountID != "" {
		*endpoint = fmt.Sprintf("https://%s.r2.cloudflarestorage.com", *accountID)
	}
	if *bucket == "" || *accessKey == "" || *secretKey == "" {
		return errors.New("bucket, access-key and secret-key are required"), "", "", "", "", "", false
	}
	return nil, *manifestPath, *bucket, *endpoint, *accessKey, *secretKey, *createBucket
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
			options.UsePathStyle = strings.HasPrefix(endpoint, "http://")
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
	return runGo("./optimized/go", "-i", input, "-o", output, "-t", strconv.Itoa(threads))
}

func writePrefix(source, destination string, rows int64) error {
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
	for scanner.Scan() {
		if lines > rows {
			break
		}
		if _, err := writer.WriteString(scanner.Text() + "\n"); err != nil {
			return err
		}
		lines++
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

func compress(source, destination string) error {
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
	_, copyErr := io.CopyBuffer(encoder, input, make([]byte, 4*1024*1024))
	closeEncoderErr := encoder.Close()
	closeOutputErr := output.Close()
	return errors.Join(copyErr, closeEncoderErr, closeOutputErr)
}

func fileInfo(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.CopyBuffer(hash, file, make([]byte, 4*1024*1024))
	if err != nil {
		return 0, "", err
	}
	return written, hex.EncodeToString(hash.Sum(nil)), nil
}

func hardlinkOrCopy(source, destination string) error {
	_ = os.Remove(destination)
	if err := os.Link(source, destination); err == nil {
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
	_, copyErr := io.CopyBuffer(output, input, make([]byte, 4*1024*1024))
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
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

func gitRevision() string {
	output, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(output))
}
