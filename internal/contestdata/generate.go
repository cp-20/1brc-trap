package contestdata

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cp-20/1blc-trap/internal/datafile"
	"github.com/cp-20/1blc-trap/internal/progress"
	"github.com/cp-20/1blc-trap/internal/traqdata"
)

const defaultChannels = 10_000

type GenerateOptions struct {
	OutputDir   string
	RunnerDir   string
	ContestID   string
	PublicRows  int64
	PrivateRows int64
	PublicSeed  int64
	PrivateSeed int64
	Tiers       []int64
	Threads     int
	Revision    string
	Log         io.Writer
}

func Generate(options GenerateOptions) (string, error) {
	if options.PublicRows <= 0 || options.PrivateRows <= 0 || options.Threads <= 0 {
		return "", errors.New("row counts and threads must be positive")
	}
	if len(options.Tiers) == 0 {
		return "", errors.New("at least one public tier is required")
	}
	if err := os.MkdirAll(options.OutputDir, 0o755); err != nil {
		return "", err
	}
	if options.RunnerDir != "" {
		if err := os.MkdirAll(options.RunnerDir, 0o755); err != nil {
			return "", err
		}
	}
	log := options.Log
	if log == nil {
		log = io.Discard
	}
	runnerLabel := options.RunnerDir
	if runnerLabel == "" {
		runnerLabel = "disabled"
	}
	fmt.Fprintf(
		log,
		"generate contest=%s public_rows=%d private_rows=%d tiers=%v threads=%d output=%s runner=%s\n",
		options.ContestID, options.PublicRows, options.PrivateRows, options.Tiers, options.Threads, options.OutputDir, runnerLabel,
	)
	totalSteps := 8*len(options.Tiers) + 9
	if options.RunnerDir != "" {
		totalSteps++
	}
	steps := progress.NewSteps(log, totalSteps)

	publicFull := filepath.Join(options.OutputDir, fmt.Sprintf("public-%d.csv", options.PublicRows))
	privateFull := filepath.Join(options.OutputDir, fmt.Sprintf("private-%d.csv", options.PrivateRows))
	if err := generateCSV(steps, publicFull, options.PublicRows, options.PublicSeed, traqdata.PublicWordset, "public"); err != nil {
		return "", fmt.Errorf("generate public dataset: %w", err)
	}
	if err := generateCSV(steps, privateFull, options.PrivateRows, options.PrivateSeed, traqdata.PrivateWordset, "private"); err != nil {
		return "", fmt.Errorf("generate private dataset: %w", err)
	}

	tierFiles := make(map[int64]string, len(options.Tiers))
	for _, rows := range options.Tiers {
		path := filepath.Join(options.OutputDir, fmt.Sprintf("public-%d.csv", rows))
		if rows == options.PublicRows {
			path = publicFull
		} else if err := steps.RunBar(fmt.Sprintf("create public prefix (%d rows)", rows), rows, "rows", func(bar *progress.Bar) error {
			return writePrefix(publicFull, path, rows, bar.Set)
		}); err != nil {
			return "", fmt.Errorf("make %d row prefix: %w", rows, err)
		}
		tierFiles[rows] = path
	}

	items := make([]Artifact, 0, len(options.Tiers)*2+2)
	for _, rows := range options.Tiers {
		inputPath := tierFiles[rows]
		expectedPath := strings.TrimSuffix(inputPath, ".csv") + ".expected"
		if err := generateExpected(steps, fmt.Sprintf("calculate public expected output (%d rows)", rows), log, inputPath, expectedPath, options.Threads); err != nil {
			return "", fmt.Errorf("expected for %d rows: %w", rows, err)
		}
		label := tierLabel(rows)
		inputArtifact, err := packageArtifact(steps, options.ContestID, fmt.Sprintf("public-%s-input", label), "input", "Public "+strings.ToUpper(label)+" input", rows, true, inputPath)
		if err != nil {
			return "", err
		}
		expectedArtifact, err := packageArtifact(steps, options.ContestID, fmt.Sprintf("public-%s-expected", label), "expected", "Public "+strings.ToUpper(label)+" expected", rows, true, expectedPath)
		if err != nil {
			return "", err
		}
		items = append(items, inputArtifact, expectedArtifact)
	}

	privateExpected := strings.TrimSuffix(privateFull, ".csv") + ".expected"
	if err := generateExpected(steps, fmt.Sprintf("calculate private expected output (%d rows)", options.PrivateRows), log, privateFull, privateExpected, options.Threads); err != nil {
		return "", fmt.Errorf("private expected: %w", err)
	}
	privateInput, err := packageArtifact(steps, options.ContestID, "private-1b-input", "input", "Private 1B input", options.PrivateRows, false, privateFull)
	if err != nil {
		return "", err
	}
	privateOutput, err := packageArtifact(steps, options.ContestID, "private-1b-expected", "expected", "Private 1B expected", options.PrivateRows, false, privateExpected)
	if err != nil {
		return "", err
	}
	items = append(items, privateInput, privateOutput)

	manifestPath := filepath.Join(options.OutputDir, "manifest.json")
	manifest := Manifest{
		SchemaVersion:     1,
		ContestID:         options.ContestID,
		GeneratedAt:       time.Now().UTC().Format(time.RFC3339),
		GeneratorRevision: options.Revision,
		Artifacts:         items,
	}
	if err := steps.Run("write manifest", func() error { return WriteManifest(manifestPath, manifest) }); err != nil {
		return "", err
	}

	if options.RunnerDir != "" {
		publicExpected := strings.TrimSuffix(tierFiles[options.Tiers[len(options.Tiers)-1]], ".csv") + ".expected"
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
				return "", err
			}
			runnerBytes += info.Size()
		}
		if err := steps.RunBar("prepare runner files", runnerBytes, "bytes", func(bar *progress.Bar) error {
			for source, name := range runnerFiles {
				if err := datafile.LinkOrCopy(source, filepath.Join(options.RunnerDir, name), bar); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return "", err
		}
	}
	fmt.Fprintf(log, "generate complete: manifest=%s runner=%s\n", manifestPath, runnerLabel)
	return manifestPath, nil
}

func generateCSV(steps *progress.Steps, path string, rows, seed int64, wordset traqdata.Wordset, scope string) error {
	return steps.RunBar(fmt.Sprintf("generate %s dataset (%d rows)", scope, rows), rows, "rows", func(bar *progress.Bar) error {
		return traqdata.GenerateFile(path, traqdata.Options{
			Rows: rows, Channels: defaultChannels, Seed: seed, Wordset: wordset, Progress: bar.Set,
		})
	})
}
