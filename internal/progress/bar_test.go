package progress

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

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
