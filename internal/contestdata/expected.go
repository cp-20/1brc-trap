package contestdata

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/cp-20/1blc-trap/internal/expected"
	"github.com/cp-20/1blc-trap/internal/progress"
)

func generateExpected(steps *progress.Steps, label string, log io.Writer, input, output string, threads int) error {
	info, err := os.Stat(input)
	if err != nil {
		return err
	}
	return steps.RunBar(label, info.Size(), "bytes", func(bar *progress.Bar) error {
		file, err := os.Create(output)
		if err != nil {
			return err
		}
		return errors.Join(expected.Generate(input, file, expected.Options{
			Threads: threads, Profile: true, Log: log, Progress: bar.Add,
		}), file.Close())
	})
}

func writePrefix(source, destination string, rows int64, report func(int64)) (err error) {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, output.Close()) }()

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
	return writer.Flush()
}
