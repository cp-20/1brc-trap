package r2

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/cp-20/1blc-trap/internal/contestdata"
	"github.com/cp-20/1blc-trap/internal/datafile"
	"github.com/cp-20/1blc-trap/internal/progress"
)

type UploadOptions struct {
	ManifestPath string
	Config       Config
	CreateBucket bool
	Log          io.Writer
}

type DownloadOptions struct {
	ManifestPath string
	OutputDir    string
	Config       Config
	Log          io.Writer
}

type uploadProgressListener struct {
	bar *progress.Bar
}

func (listener uploadProgressListener) OnObjectBytesTransferred(_ context.Context, event *transfermanager.ObjectBytesTransferredEvent) {
	listener.bar.Set(event.BytesTransferred)
}

func Upload(options UploadOptions) error {
	manifest, err := contestdata.ReadManifest(options.ManifestPath)
	if err != nil {
		return err
	}
	client, err := newClient(options.Config)
	if err != nil {
		return err
	}
	log := options.Log
	if log == nil {
		log = io.Discard
	}
	ctx := context.Background()
	if options.CreateBucket {
		fmt.Fprintf(log, "ensure bucket exists: %s\n", options.Config.Bucket)
		_, _ = client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(options.Config.Bucket)})
	}
	fmt.Fprintf(log, "upload manifest=%s bucket=%s endpoint=%s artifacts=%d\n", options.ManifestPath, options.Config.Bucket, options.Config.Endpoint, len(manifest.Artifacts))
	steps := progress.NewSteps(log, 2*len(manifest.Artifacts))
	transfer := transfermanager.New(client)
	base := filepath.Dir(options.ManifestPath)
	for _, item := range manifest.Artifacts {
		path := filepath.Join(base, filepath.Base(item.ObjectKey))
		if err := steps.RunBar("verify "+item.ObjectKey, item.CompressedBytes, "bytes", func(bar *progress.Bar) error {
			size, digest, err := datafile.Info(path, bar)
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
		if err := steps.RunBar("upload "+item.ObjectKey, item.CompressedBytes, "bytes", func(bar *progress.Bar) error {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			_, uploadErr := transfer.UploadObject(ctx, &transfermanager.UploadObjectInput{
				Bucket:      aws.String(options.Config.Bucket),
				Key:         aws.String(item.ObjectKey),
				Body:        file,
				ContentType: aws.String("application/zstd"),
			}, func(settings *transfermanager.Options) {
				settings.ObjectProgressListeners.Register(uploadProgressListener{bar: bar})
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
	fmt.Fprintf(log, "upload complete: %d artifacts\n", len(manifest.Artifacts))
	return nil
}

func Download(options DownloadOptions) error {
	manifest, err := contestdata.ReadManifest(options.ManifestPath)
	if err != nil {
		return err
	}
	client, err := newClient(options.Config)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(options.OutputDir, 0o755); err != nil {
		return err
	}
	log := options.Log
	if log == nil {
		log = io.Discard
	}
	fmt.Fprintf(log, "download manifest=%s bucket=%s endpoint=%s artifacts=%d output=%s\n", options.ManifestPath, options.Config.Bucket, options.Config.Endpoint, len(manifest.Artifacts), options.OutputDir)
	steps := progress.NewSteps(log, len(manifest.Artifacts))
	transfer := transfermanager.New(client)
	for _, item := range manifest.Artifacts {
		if err := steps.Run(fmt.Sprintf("download and verify %s (%d bytes)", item.ObjectKey, item.CompressedBytes), func() error {
			path := filepath.Join(options.OutputDir, filepath.Base(item.ObjectKey))
			file, err := os.Create(path)
			if err != nil {
				return err
			}
			_, downloadErr := transfer.DownloadObject(context.Background(), &transfermanager.DownloadObjectInput{
				Bucket: aws.String(options.Config.Bucket), Key: aws.String(item.ObjectKey), WriterAt: file,
			})
			closeErr := file.Close()
			if downloadErr != nil {
				return downloadErr
			}
			if closeErr != nil {
				return closeErr
			}
			_, digest, err := datafile.Info(path, nil)
			if err != nil {
				return err
			}
			if digest != item.CompressedSHA256 {
				return fmt.Errorf("checksum mismatch for %s", item.ObjectKey)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	fmt.Fprintf(log, "download complete: %d artifacts\n", len(manifest.Artifacts))
	return nil
}
