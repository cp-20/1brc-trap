package datafile

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"runtime"

	"github.com/cp-20/1blc-trap/internal/progress"
	"github.com/klauspost/compress/zstd"
)

const bufferSize = 4 * 1024 * 1024

func Compress(source, destination string, bar *progress.Bar) error {
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
		_ = output.Close()
		return err
	}
	var reader io.Reader = input
	if bar != nil {
		reader = bar.Reader(input)
	}
	_, copyErr := io.CopyBuffer(encoder, reader, make([]byte, bufferSize))
	return errors.Join(copyErr, encoder.Close(), output.Close())
}

func Info(path string, bar *progress.Bar) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	var reader io.Reader = file
	if bar != nil {
		reader = bar.Reader(file)
	}
	written, err := io.CopyBuffer(hash, reader, make([]byte, bufferSize))
	if err != nil {
		return 0, "", err
	}
	return written, hex.EncodeToString(hash.Sum(nil)), nil
}

func LinkOrCopy(source, destination string, bar *progress.Bar) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	_ = os.Remove(destination)
	if err := os.Link(source, destination); err == nil {
		if bar != nil {
			bar.Add(info.Size())
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
	if bar != nil {
		reader = bar.Reader(input)
	}
	_, copyErr := io.CopyBuffer(output, reader, make([]byte, bufferSize))
	return errors.Join(copyErr, output.Close())
}
