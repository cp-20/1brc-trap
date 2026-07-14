package contestdata

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/cp-20/1blc-trap/internal/datafile"
	"github.com/cp-20/1blc-trap/internal/progress"
)

func packageArtifact(steps *progress.Steps, contestID, id, kind, label string, rows int64, public bool, path string) (Artifact, error) {
	sourceInfo, err := os.Stat(path)
	if err != nil {
		return Artifact{}, err
	}
	compressedPath := path + ".zst"
	if err := steps.RunBar("compress "+label, sourceInfo.Size(), "bytes", func(bar *progress.Bar) error {
		return datafile.Compress(path, compressedPath, bar)
	}); err != nil {
		return Artifact{}, fmt.Errorf("compress %s: %w", path, err)
	}
	var uncompressedSize int64
	var uncompressedHash string
	if err := steps.RunBar("checksum "+label+" source", sourceInfo.Size(), "bytes", func(bar *progress.Bar) error {
		var err error
		uncompressedSize, uncompressedHash, err = datafile.Info(path, bar)
		return err
	}); err != nil {
		return Artifact{}, err
	}
	compressedInfo, err := os.Stat(compressedPath)
	if err != nil {
		return Artifact{}, err
	}
	var compressedSize int64
	var compressedHash string
	if err := steps.RunBar("checksum "+label+" archive", compressedInfo.Size(), "bytes", func(bar *progress.Bar) error {
		var err error
		compressedSize, compressedHash, err = datafile.Info(compressedPath, bar)
		return err
	}); err != nil {
		return Artifact{}, err
	}
	scope := "private"
	if public {
		scope = "public"
	}
	return Artifact{
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
	}, nil
}
