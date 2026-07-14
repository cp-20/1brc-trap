package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/cp-20/1blc-trap/internal/contestdata"
	"github.com/cp-20/1blc-trap/internal/r2"
)

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
	tiers := flags.String("tiers", "1000000,10000000,100000000,1000000000", "comma-separated public tiers")
	threads := flags.Int("threads", runtime.NumCPU(), "expected generator threads")
	revision := flags.String("revision", gitRevision(), "generator revision")
	if err := flags.Parse(args); err != nil {
		return err
	}
	parsedTiers, err := contestdata.ParseTiers(*tiers, *publicRows)
	if err != nil {
		return err
	}
	_, err = contestdata.Generate(contestdata.GenerateOptions{
		OutputDir:   *outputDir,
		RunnerDir:   *runnerDir,
		ContestID:   *contestID,
		PublicRows:  *publicRows,
		PrivateRows: *privateRows,
		PublicSeed:  *publicSeed,
		PrivateSeed: *privateSeed,
		Tiers:       parsedTiers,
		Threads:     *threads,
		Revision:    *revision,
		Log:         os.Stderr,
	})
	return err
}

func upload(args []string) error {
	flags := flag.NewFlagSet("upload", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	accessKey, secretKey := r2WriteCredentials()
	storage := addR2Flags(flags, accessKey, secretKey)
	createBucket := flags.Bool("create-bucket", false, "create bucket when it does not exist")
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := storage.config()
	if err != nil {
		return err
	}
	return r2.Upload(r2.UploadOptions{
		ManifestPath: *manifestPath,
		Config:       config,
		CreateBucket: *createBucket,
		Log:          os.Stderr,
	})
}

func presignRunner(args []string) error {
	flags := flag.NewFlagSet("presign-runner", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	outputPath := flags.String("output", "data/contest/runner-downloads.json", "output path")
	expires := flags.Duration("expires", 24*time.Hour, "presigned URL lifetime")
	accessKey, secretKey := r2WriteCredentials()
	storage := addR2Flags(flags, accessKey, secretKey)
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := storage.config()
	if err != nil {
		return err
	}
	return r2.PresignRunner(r2.PresignOptions{
		ManifestPath: *manifestPath,
		OutputPath:   *outputPath,
		Expires:      *expires,
		Config:       config,
		Log:          os.Stderr,
	})
}

func download(args []string) error {
	flags := flag.NewFlagSet("download", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "data/contest/manifest.json", "manifest path")
	outputDir := flags.String("output", "data/contest/download", "output directory")
	storage := addR2Flags(flags, os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"))
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := storage.config()
	if err != nil {
		return err
	}
	return r2.Download(r2.DownloadOptions{
		ManifestPath: *manifestPath,
		OutputDir:    *outputDir,
		Config:       config,
		Log:          os.Stderr,
	})
}

type r2FlagValues struct {
	bucket, endpoint, accountID, accessKey, secretKey *string
}

func addR2Flags(flags *flag.FlagSet, defaultAccessKey, defaultSecretKey string) r2FlagValues {
	return r2FlagValues{
		bucket:    flags.String("bucket", "", "bucket name"),
		endpoint:  flags.String("endpoint", os.Getenv("R2_ENDPOINT"), "R2 S3 endpoint"),
		accountID: flags.String("account-id", os.Getenv("R2_ACCOUNT_ID"), "R2 account ID"),
		accessKey: flags.String("access-key", defaultAccessKey, "access key"),
		secretKey: flags.String("secret-key", defaultSecretKey, "secret key"),
	}
}

func (values r2FlagValues) config() (r2.Config, error) {
	endpoint, err := r2.ResolveEndpoint(*values.endpoint, *values.accountID)
	if err != nil {
		return r2.Config{}, err
	}
	config := r2.Config{
		Bucket: *values.bucket, Endpoint: endpoint, AccessKey: *values.accessKey, SecretKey: *values.secretKey,
	}
	if err := config.Validate(); err != nil {
		return r2.Config{}, err
	}
	return config, nil
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

func gitRevision() string {
	output, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(output))
}
