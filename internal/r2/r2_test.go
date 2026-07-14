package r2

import (
	"testing"

	"github.com/cp-20/1blc-trap/internal/contestdata"
)

func TestResolveEndpoint(t *testing.T) {
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
			got, err := ResolveEndpoint(test.endpoint, test.accountID)
			if (err != nil) != test.wantError {
				t.Fatalf("ResolveEndpoint() error = %v, wantError = %v", err, test.wantError)
			}
			if got != test.want {
				t.Fatalf("ResolveEndpoint() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSelectRunnerArtifactsUsesLargestPublicDataset(t *testing.T) {
	manifest := contestdata.Manifest{Artifacts: []contestdata.Artifact{
		{Kind: "input", Rows: 10, IsPublic: true, ObjectKey: "public-10.csv.zst"},
		{Kind: "expected", Rows: 10, IsPublic: true, ObjectKey: "public-10.expected.zst"},
		{Kind: "input", Rows: 100, IsPublic: true, ObjectKey: "public-100.csv.zst"},
		{Kind: "expected", Rows: 100, IsPublic: true, ObjectKey: "public-100.expected.zst"},
		{Kind: "input", Rows: 200, ObjectKey: "private.csv.zst"},
		{Kind: "expected", Rows: 200, ObjectKey: "private.expected.zst"},
	}}
	got, err := selectRunnerArtifacts(manifest)
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
