package r2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/cp-20/1blc-trap/internal/contestdata"
)

var runnerFileNames = [...]string{"public.csv", "public.expected", "private.csv", "private.expected"}

type PresignOptions struct {
	ManifestPath string
	OutputPath   string
	Expires      time.Duration
	Config       Config
	Log          io.Writer
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

func PresignRunner(options PresignOptions) error {
	if options.Expires < time.Second || options.Expires > 7*24*time.Hour {
		return errors.New("expires must be between 1s and 168h")
	}
	manifest, err := contestdata.ReadManifest(options.ManifestPath)
	if err != nil {
		return err
	}
	artifacts, err := selectRunnerArtifacts(manifest)
	if err != nil {
		return err
	}
	client, err := newClient(options.Config)
	if err != nil {
		return err
	}
	presigner := s3.NewPresignClient(client)
	now := time.Now().UTC()
	downloads := runnerDownloads{
		GeneratedAt: now.Format(time.RFC3339),
		ExpiresAt:   now.Add(options.Expires).Format(time.RFC3339),
		Files:       make(map[string]runnerDownload, len(artifacts)),
	}
	for _, name := range runnerFileNames {
		item := artifacts[name]
		request, err := presigner.PresignGetObject(context.Background(), &s3.GetObjectInput{
			Bucket: aws.String(options.Config.Bucket),
			Key:    aws.String(item.ObjectKey),
		}, s3.WithPresignExpires(options.Expires))
		if err != nil {
			return fmt.Errorf("presign %s: %w", item.ObjectKey, err)
		}
		downloads.Files[name] = runnerDownload{
			URL: request.URL, SHA256: item.UncompressedSHA256, CompressedSHA256: item.CompressedSHA256,
		}
	}
	if err := os.MkdirAll(filepath.Dir(options.OutputPath), 0o755); err != nil {
		return err
	}
	if err := writeJSON(options.OutputPath, downloads, 0o600); err != nil {
		return err
	}
	log := options.Log
	if log == nil {
		log = io.Discard
	}
	fmt.Fprintf(log, "presigned %d runner downloads until %s: %s\n", len(downloads.Files), downloads.ExpiresAt, options.OutputPath)
	return nil
}

func selectRunnerArtifacts(manifest contestdata.Manifest) (map[string]contestdata.Artifact, error) {
	rowsByScope := map[bool]int64{}
	for _, item := range manifest.Artifacts {
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
	selected := make(map[string]contestdata.Artifact, len(targets))
	for _, target := range targets {
		for _, item := range manifest.Artifacts {
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

func writeJSON(path string, value any, mode os.FileMode) error {
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
