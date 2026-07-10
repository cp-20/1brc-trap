package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestParseTiers(t *testing.T) {
	got, err := parseTiers("100,10,100", 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{10, 100, 1000}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestGeneratorIsDeterministicAndOptimizedMatchesBaseline(t *testing.T) {
	repository, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	first := filepath.Join(directory, "first.csv")
	second := filepath.Join(directory, "second.csv")
	optimized := filepath.Join(directory, "optimized.expected")
	baseline := filepath.Join(directory, "baseline.expected")

	runRepositoryGo(t, repository, "./cmd/traq_data", "-n", "2000", "-channels", "100", "-seed", "424242", "-o", first)
	runRepositoryGo(t, repository, "./cmd/traq_data", "-n", "2000", "-channels", "100", "-seed", "424242", "-o", second)
	firstContent, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	secondContent, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstContent, secondContent) {
		t.Fatal("the same seed did not produce identical CSV data")
	}

	runRepositoryGo(t, repository, "./optimized/go", "-i", first, "-o", optimized, "-t", "2")
	runRepositoryGo(t, repository, "./baselines/go", "-i", first, "-o", baseline)
	optimizedContent, err := os.ReadFile(optimized)
	if err != nil {
		t.Fatal(err)
	}
	baselineContent, err := os.ReadFile(baseline)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(optimizedContent, baselineContent) {
		t.Fatal("optimized Go expected result differs from the independent Go baseline")
	}
}

func runRepositoryGo(t *testing.T, repository string, arguments ...string) {
	t.Helper()
	command := exec.Command("go", append([]string{"run"}, arguments...)...)
	command.Dir = repository
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go %v: %v\n%s", arguments, err, output)
	}
}

func TestWritePrefix(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source.csv")
	destination := filepath.Join(directory, "prefix.csv")
	if err := os.WriteFile(source, []byte("header\na\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePrefix(source, destination, 2); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "header\na\nb\n" {
		t.Fatalf("unexpected prefix: %q", content)
	}
}

func TestZstdRoundTripAndChecksums(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "fixture.csv")
	compressed := source + ".zst"
	want := []byte("unix_timestamp,channel_path,message_length,stamp_count\n1798761600,a,42,1\n")
	if err := os.WriteFile(source, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := compress(source, compressed); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(compressed)
	if err != nil {
		t.Fatal(err)
	}
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer decoder.Close()
	got, err := decoder.DecodeAll(encoded, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("zstd round trip differs: %q", got)
	}
	size, digest, err := fileInfo(compressed)
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(encoded)) || len(digest) != 64 {
		t.Fatalf("invalid metadata: size=%d digest=%q", size, digest)
	}
}
