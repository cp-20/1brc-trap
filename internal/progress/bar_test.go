package progress

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStepsReportCurrentStepAndResult(t *testing.T) {
	var output bytes.Buffer
	steps := NewSteps(&output, 2)
	if err := steps.Run("first operation", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	wantErr := errors.New("broken")
	if err := steps.Run("second operation", func() error { return wantErr }); !errors.Is(err, wantErr) {
		t.Fatalf("got %v, want %v", err, wantErr)
	}

	log := output.String()
	for _, want := range []string{
		"[1/2] first operation",
		"[1/2] done: first operation",
		"[2/2] second operation",
		"[2/2] failed: second operation",
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("progress log does not contain %q:\n%s", want, log)
		}
	}
}

func TestBarShowsProgressRateAndETA(t *testing.T) {
	var output bytes.Buffer
	bar := New(&output, 1_000_000, "rows")
	bar.started = time.Now().Add(-10 * time.Second)
	bar.Set(500_000)
	bar.Done(false)

	log := output.String()
	for _, want := range []string{
		"[============------------]",
		"50.0%",
		"500,000 rows / 1,000,000 rows",
		"rows/s",
		"ETA",
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("progress log does not contain %q: %s", want, log)
		}
	}
}

func TestInteractiveBarRewritesOneLine(t *testing.T) {
	var output bytes.Buffer
	bar := New(&output, 100, "rows")
	bar.interactive = true
	bar.started = time.Now().Add(-10 * time.Second)
	bar.Set(50)
	bar.Done(true)

	log := output.String()
	if strings.Count(log, "\r") != 2 || strings.Count(log, "\n") != 1 {
		t.Fatalf("interactive progress should rewrite one line and end it once: %q", log)
	}
}
