package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/pprof"
	"strings"

	"github.com/cp-20/1blc-trap/internal/expected"
	"github.com/cp-20/1blc-trap/internal/progress"
)

func main() {
	input := flag.String("i", "", "input CSV file path; required for mmap")
	output := flag.String("o", "", "output file path; default is stdout")
	threads := flag.Int("t", runtime.NumCPU(), "worker thread count")
	profileEnabled := flag.Bool("profile", false, "print timing profile to stderr")
	showProgress := flag.Bool("progress", false, "print input progress to stderr")
	cpuProfile := flag.String("cpuprofile", "", "write CPU profile to file")
	if len(os.Args) == 3 && !strings.HasPrefix(os.Args[1], "-") && !strings.HasPrefix(os.Args[2], "-") {
		*input, *output = os.Args[1], os.Args[2]
	} else {
		flag.Parse()
	}

	if *input == "" {
		exit("optimized Go analyzer requires -i")
	}
	stopProfile, err := startCPUProfile(*cpuProfile)
	if err != nil {
		exit(err.Error())
	}
	defer stopProfile()

	writer, closeWriter, err := openOutput(*output)
	if err != nil {
		exit(err.Error())
	}
	defer closeWriter()

	var bar *progress.Bar
	var report func(int64)
	if *showProgress {
		info, err := os.Stat(*input)
		if err != nil {
			exit(err.Error())
		}
		bar = progress.New(os.Stderr, info.Size(), "bytes")
		report = bar.Add
	}
	err = expected.Generate(*input, writer, expected.Options{
		Threads: *threads, Profile: *profileEnabled, Log: os.Stderr, Progress: report,
	})
	if bar != nil {
		bar.Done(err == nil)
	}
	if err != nil {
		exit(err.Error())
	}
}

func openOutput(path string) (io.Writer, func() error, error) {
	if path == "" {
		return os.Stdout, func() error { return nil }, nil
	}
	file, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create output: %w", err)
	}
	return file, file.Close, nil
}

func startCPUProfile(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	file, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("failed to create CPU profile: %w", err)
	}
	if err := pprof.StartCPUProfile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("failed to start CPU profile: %w", err)
	}
	return func() {
		pprof.StopCPUProfile()
		_ = file.Close()
	}, nil
}

func exit(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
