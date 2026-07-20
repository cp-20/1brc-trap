package server

import (
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
)

func TestHealthAndAPINotFound(t *testing.T) {
	application := New(Config{TrustProxyHeader: false, StaticRoot: t.TempDir()}, nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	handler := application.Handler()

	for _, test := range []struct {
		path        string
		status      int
		body        string
		contentType string
	}{
		{path: "/api/v1/healthz", status: http.StatusOK, body: `{"ok":true}` + "\n", contentType: "application/json; charset=UTF-8"},
		{path: "/api/v1/missing", status: http.StatusNotFound, body: `{"error":{"code":"not_found","message":"Not found","requestId":"request-1"}}` + "\n", contentType: "application/json; charset=UTF-8"},
	} {
		request := httptest.NewRequest(http.MethodGet, test.path, nil)
		request.Header.Set("X-Request-Id", "request-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.status || response.Body.String() != test.body {
			t.Fatalf("%s: got status=%d body=%q", test.path, response.Code, response.Body.String())
		}
		if got := response.Header().Get("Content-Type"); got != test.contentType {
			t.Fatalf("%s: Content-Type=%q", test.path, got)
		}
		if got := response.Header().Get("X-Request-Id"); got != "request-1" {
			t.Fatalf("%s: X-Request-Id=%q", test.path, got)
		}
	}
}

func TestSubmissionPrivateFieldVisibility(t *testing.T) {
	row := submissionRow{
		id: "00000000-0000-4000-8000-000000000001", username: "alice", status: "completed",
		language: sql.NullString{String: "go", Valid: true}, publicVerdict: sql.NullString{String: "accepted", Valid: true},
		publicScoreNS: sql.NullString{String: "123", Valid: true}, uploadStartedAt: time.Date(2026, 1, 2, 3, 4, 5, 600_000_000, time.UTC),
	}
	before := serializeSubmission(row, false)
	if _, exists := before["private"]; exists {
		t.Fatal("private must be omitted before publication")
	}
	after := serializeSubmission(row, true)
	if value, exists := after["private"]; !exists || value != nil {
		t.Fatalf("private after publication = %#v, exists=%v", value, exists)
	}
	encoded, err := json.Marshal(before)
	if err != nil || !json.Valid(encoded) {
		t.Fatalf("serialized submission is invalid JSON: %v", err)
	}
}

func TestLeaderboardRanking(t *testing.T) {
	rows := []leaderboardRecord{
		{username: "slow", id: "slow", language: "go", publicVerdict: "accepted", publicScore: sql.NullString{String: "1000", Valid: true}, submittedAt: time.Unix(1, 0)},
		{username: "fast", id: "fast", language: "rust", publicVerdict: "accepted", publicScore: sql.NullString{String: "99", Valid: true}, submittedAt: time.Unix(2, 0)},
		{username: "dq", id: "dq", language: "c", publicVerdict: "accepted", publicScore: sql.NullString{String: "1", Valid: true}, disqualified: sql.NullString{String: "reason", Valid: true}, submittedAt: time.Unix(3, 0)},
	}
	result := buildLeaderboard(rows, api.Public, false)
	if len(result.Ranked) != 2 || result.Ranked[0].SubmissionId != "fast" || *result.Ranked[0].Rank != 1 {
		t.Fatalf("unexpected ranked entries: %#v", result.Ranked)
	}
	if len(result.Disqualified) != 1 || result.Disqualified[0].Verdict != api.Disqualified {
		t.Fatalf("unexpected disqualified entries: %#v", result.Disqualified)
	}
}

func TestManifestCrossFieldValidation(t *testing.T) {
	manifest := api.DatasetManifest{
		SchemaVersion: api.N1, ContestId: "contest", GeneratedAt: "2026-01-01T00:00:00Z", GeneratorRevision: "revision",
		Artifacts: []api.DatasetArtifact{
			artifact("public-input", api.Input, true), artifact("public-expected", api.Expected, true),
			artifact("private-input", api.Input, false), artifact("private-expected", api.Expected, false),
		},
	}
	if err := validateManifest(manifest); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	manifest.Artifacts[1].ObjectKey = manifest.Artifacts[0].ObjectKey
	if err := validateManifest(manifest); err == nil {
		t.Fatal("duplicate object key accepted")
	}
}

func TestJavaScriptStringCompatibility(t *testing.T) {
	if got := encodeURIComponent("a+b c!()日本語.txt"); got != "a%2Bb%20c!()%E6%97%A5%E6%9C%AC%E8%AA%9E.txt" {
		t.Fatalf("encodeURIComponent = %q", got)
	}
	if got := utf16Length("a😀b"); got != 4 {
		t.Fatalf("utf16Length = %d", got)
	}
	if got := truncateUTF16(strings.Repeat("a", 8192)+"b", 8192); len(got) != 8192 || strings.HasSuffix(got, "b") {
		t.Fatalf("truncateUTF16 produced an invalid prefix")
	}
}

func TestRunnerResultValidation(t *testing.T) {
	valid := `{"public":{"verdict":"accepted","durationsNs":["1","2","3"],"medianNs":"2","error":null},"private":null,"environmentId":"environment"}`
	if _, err := decodeRunnerResult([]byte(valid)); err != nil {
		t.Fatalf("valid result rejected: %v", err)
	}
	invalid := []string{
		strings.Replace(valid, `"medianNs":"2"`, `"medianNs":"invalid"`, 1),
		strings.Replace(valid, `,"private":null`, "", 1),
		strings.Replace(valid, `,"environmentId"`, `,"unknown":true,"environmentId"`, 1),
		valid + `{}`,
	}
	for _, input := range invalid {
		if _, err := decodeRunnerResult([]byte(input)); err == nil {
			t.Fatalf("invalid result accepted: %s", input)
		}
	}
}

func TestValidationRunsBeforeAdminAuthorization(t *testing.T) {
	application := New(Config{StaticRoot: t.TempDir()}, nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, path := range []string{"/api/v1/admin/datasets/import", "/api/v1/admin/submissions/id/disqualify"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{"))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

func TestGeneratedRouterPreservesQueryValidation(t *testing.T) {
	application := New(Config{StaticRoot: t.TempDir()}, nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/leaderboard?board=unknown", nil)
	request.Header.Set("X-Request-Id", "query-test")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func artifact(id string, kind api.DatasetKind, public bool) api.DatasetArtifact {
	scope := "private"
	if public {
		scope = "public"
	}
	return api.DatasetArtifact{Id: id, Kind: kind, Label: id, ObjectKey: "datasets/contest/" + scope + "/" + id + ".zst", Rows: 1, CompressedBytes: 1, UncompressedBytes: 1, CompressedSha256: strings.Repeat("a", 64), UncompressedSha256: strings.Repeat("b", 64), IsPublic: public}
}
