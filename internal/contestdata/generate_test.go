package contestdata

import (
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGenerateWritesManifestAndRunnerFiles(t *testing.T) {
	directory := t.TempDir()
	output := filepath.Join(directory, "output")
	runner := filepath.Join(directory, "runner")
	manifestPath, err := Generate(GenerateOptions{
		OutputDir: output, RunnerDir: runner, ContestID: "test", PublicRows: 100, PrivateRows: 100,
		PublicSeed: 1, PrivateSeed: 2, Tiers: []int64{25, 100}, Threads: 2, Revision: "test", Log: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ReadManifest(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Artifacts) != 6 {
		t.Fatalf("got %d artifacts, want 6", len(manifest.Artifacts))
	}
	for _, name := range []string{"public.csv", "public.expected", "private.csv", "private.expected"} {
		if _, err := os.Stat(filepath.Join(runner, name)); err != nil {
			t.Fatalf("runner file %s: %v", name, err)
		}
	}
}

func TestParseTiers(t *testing.T) {
	got, err := ParseTiers("100,10,100", 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{10, 100, 1000}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestWritePrefix(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source.csv")
	destination := filepath.Join(directory, "prefix.csv")
	if err := os.WriteFile(source, []byte("header\na\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePrefix(source, destination, 2, nil); err != nil {
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
