package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestProgressReportsCurrentStepAndResult(t *testing.T) {
	var output bytes.Buffer
	progress := newProgress(&output, 2)
	if err := progress.run("first operation", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	wantErr := errors.New("broken")
	if err := progress.run("second operation", func() error { return wantErr }); !errors.Is(err, wantErr) {
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

func TestResolveR2Endpoint(t *testing.T) {
	tests := []struct {
		name      string
		endpoint  string
		accountID string
		want      string
		wantError bool
	}{
		{name: "explicit endpoint", endpoint: "https://r2.example.com/", want: "https://r2.example.com"},
		{name: "account endpoint", accountID: "account-id", want: "https://account-id.r2.cloudflarestorage.com"},
		{name: "missing endpoint", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveR2Endpoint(test.endpoint, test.accountID)
			if (err != nil) != test.wantError {
				t.Fatalf("resolveR2Endpoint() error = %v, wantError = %v", err, test.wantError)
			}
			if got != test.want {
				t.Fatalf("resolveR2Endpoint() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSelectRunnerArtifactsUsesLargestPublicDataset(t *testing.T) {
	data := manifest{Artifacts: []artifact{
		{Kind: "input", Rows: 10, IsPublic: true, ObjectKey: "public-10.csv.zst"},
		{Kind: "expected", Rows: 10, IsPublic: true, ObjectKey: "public-10.expected.zst"},
		{Kind: "input", Rows: 100, IsPublic: true, ObjectKey: "public-100.csv.zst"},
		{Kind: "expected", Rows: 100, IsPublic: true, ObjectKey: "public-100.expected.zst"},
		{Kind: "input", Rows: 200, ObjectKey: "private.csv.zst"},
		{Kind: "expected", Rows: 200, ObjectKey: "private.expected.zst"},
	}}
	got, err := selectRunnerArtifacts(data)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"public.csv":       "public-100.csv.zst",
		"public.expected":  "public-100.expected.zst",
		"private.csv":      "private.csv.zst",
		"private.expected": "private.expected.zst",
	}
	for name, objectKey := range want {
		if got[name].ObjectKey != objectKey {
			t.Fatalf("%s object key = %q, want %q", name, got[name].ObjectKey, objectKey)
		}
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

func TestZstdRoundTripAndChecksums(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "fixture.csv")
	compressed := source + ".zst"
	want := []byte("unix_timestamp,channel_path,message_length,stamp_count\n1798761600,a,42,1\n")
	if err := os.WriteFile(source, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := compress(source, compressed, nil); err != nil {
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
	size, digest, err := fileInfo(compressed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(encoded)) || len(digest) != 64 {
		t.Fatalf("invalid metadata: size=%d digest=%q", size, digest)
	}
}
