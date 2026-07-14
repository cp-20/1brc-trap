package datafile

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestCompressRoundTripAndInfo(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "fixture.csv")
	compressed := source + ".zst"
	want := []byte("unix_timestamp,channel_path,message_length,stamp_count\n1798761600,a,42,1\n")
	if err := os.WriteFile(source, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Compress(source, compressed, nil); err != nil {
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
	size, digest, err := Info(compressed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(encoded)) || len(digest) != 64 {
		t.Fatalf("invalid metadata: size=%d digest=%q", size, digest)
	}
}
