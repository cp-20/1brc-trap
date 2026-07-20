package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
)

func (s *Server) GetHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}
func (s *Server) GetReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, api.OkResponse{Ok: false})
		return
	}
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}
func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) {
	user := authenticated(r)
	response := api.MeResponse{}
	if user != nil {
		response.User = &api.AuthUser{Username: user.username, IsAdmin: user.isAdmin, Method: user.method}
	}
	writeJSON(w, http.StatusOK, response)
}
func (s *Server) IssueAccessKey(w http.ResponseWriter, r *http.Request) {
	user, err := s.requireHeaderUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	issued, err := s.issueAccessKey(r.Context(), user.username)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, issued)
}
func (s *Server) RevokeAccessKey(w http.ResponseWriter, r *http.Request) {
	user, err := s.requireHeaderUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.revokeAccessKey(r.Context(), user.username); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) GetContest(w http.ResponseWriter, r *http.Request) {
	published, publishedAt, err := s.privatePublished(r.Context())
	_ = published
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	participants, total, err := s.participationStats(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var publishedString *string
	if publishedAt != nil {
		value := isoTime(*publishedAt)
		publishedString = &value
	}
	writeJSON(w, http.StatusOK, api.ContestOverview{Id: s.config.ContestID, Name: "1BRC for traP", StartAt: isoTime(s.config.ContestStartAt), EndAt: isoTime(s.config.ContestEndAt), PrivatePublishedAt: publishedString, Participants: participants, TotalSubmissions: total, Environment: api.BenchmarkEnvironment{Id: s.config.BenchmarkEnvironmentID, InstanceType: s.config.BenchmarkInstanceType, Cpu: s.config.BenchmarkCPU, Memory: s.config.BenchmarkMemory, Os: "Ubuntu 26.04 LTS", Kernel: s.config.BenchmarkKernel, Docker: s.config.BenchmarkDockerVersion, RunnerImage: s.config.BenchmarkRunnerImage, Node: s.config.BenchmarkNodeVersion, Bun: s.config.BenchmarkBunVersion, Ruby: s.config.BenchmarkRubyVersion, SharedLibraries: s.config.BenchmarkSharedLibraries, Repetitions: 3, SlowFirstAttemptSeconds: 60, TimeoutSeconds: 900, PidLimit: 4096, StdioLimitBytes: 1024 * 1024, OutputLimitBytes: 256 * 1024 * 1024}})
}

func validateLeaderboardParams(board *api.LeaderboardBoard, language *api.Language) error {
	if board != nil && *board != api.Public && *board != api.Private {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です")
	}
	if language != nil && !allLanguages[*language] {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です")
	}
	return nil
}
func (s *Server) loadLeaderboard(ctx context.Context, requested *api.LeaderboardBoard, language *api.Language) (api.Leaderboard, error) {
	if err := validateLeaderboardParams(requested, language); err != nil {
		return api.Leaderboard{}, err
	}
	published, _, err := s.privatePublished(ctx)
	if err != nil {
		return api.Leaderboard{}, err
	}
	rows, err := s.leaderboardRows(ctx, language)
	if err != nil {
		return api.Leaderboard{}, err
	}
	board := api.Public
	if requested != nil && *requested == api.Private && published {
		board = api.Private
	}
	return buildLeaderboard(rows, board, published), nil
}
func (s *Server) GetLeaderboard(w http.ResponseWriter, r *http.Request, params api.GetLeaderboardParams) {
	result, err := s.loadLeaderboard(r.Context(), params.Board, params.Language)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) GetLeaderboardReplay(w http.ResponseWriter, r *http.Request) {
	if !time.Now().After(s.config.ContestEndAt) {
		s.writeError(w, r, newError(conflict, "contest_not_ended", "順位推移はコンテスト終了後に公開されます"))
		return
	}
	published, _, err := s.privatePublished(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !published {
		s.writeError(w, r, newError(conflict, "private_not_published", "順位推移はPrivate結果の公開後に閲覧できます"))
		return
	}
	rows, err := s.leaderboardReplay(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, api.LeaderboardReplayResponse{Submissions: rows})
}

func (s *Server) GetDatasets(w http.ResponseWriter, r *http.Request) {
	rows, err := s.publicDatasets(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	datasets := make([]api.PublicDataset, 0, len(rows))
	for _, row := range rows {
		base := regexp.MustCompile(`-(input|expected)$`).ReplaceAllString(row.id, "")
		datasets = append(datasets, api.PublicDataset{Id: row.id, Kind: row.kind, Label: row.label, Rows: row.rows, CompressedBytes: row.compressedBytes, UncompressedBytes: row.uncompressedBytes, CompressedSha256: row.compressedSHA, UncompressedSha256: row.uncompressedSHA, DownloadUrl: fmt.Sprintf("/api/v1/datasets/%s/%s/download", url.PathEscape(base), row.kind)})
	}
	writeJSON(w, http.StatusOK, api.DatasetsResponse{Datasets: datasets})
}
func (s *Server) DownloadDataset(w http.ResponseWriter, r *http.Request, datasetID string, artifact api.DatasetKind) {
	if artifact != api.Input && artifact != api.Expected {
		s.writeError(w, r, newError(notFound, "dataset_not_found", "公開データが見つかりません"))
		return
	}
	row, err := s.publicDataset(r.Context(), sanitizeDownloadID(datasetID, artifact))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if row == nil || !strings.HasPrefix(row.objectKey, fmt.Sprintf("datasets/%s/public/", s.config.ContestID)) {
		s.writeError(w, r, newError(notFound, "dataset_not_found", "公開データが見つかりません"))
		return
	}
	location, err := s.r2.signDownload(r.Context(), row.objectKey, path.Base(row.objectKey))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, location, http.StatusFound)
}

func (s *Server) CreateSubmission(w http.ResponseWriter, r *http.Request) {
	user, err := s.requireUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	reserved, err := s.acceptSubmission(w, r, user.username)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	location := "/api/v1/submissions/" + reserved.id
	w.Header().Set("Location", location)
	writeJSON(w, http.StatusAccepted, api.SubmissionAccepted{Id: reserved.id, Status: api.SubmissionAcceptedStatusQueued, StatusUrl: location, UploadStartedAt: isoTime(reserved.uploadStartedAt)})
}
func serializeSubmissions(rows []submissionRow, published bool) []map[string]any {
	result := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		result = append(result, serializeSubmission(row, published))
	}
	return result
}
func (s *Server) ListSubmissions(w http.ResponseWriter, r *http.Request) {
	user, err := s.requireUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	rows, err := s.submissionsForUser(r.Context(), user.username)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	published, _, err := s.privatePublished(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submissions": serializeSubmissions(rows, published)})
}
func (s *Server) GetSubmission(w http.ResponseWriter, r *http.Request, id api.Uuid) {
	user, err := s.requireUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	row, err := s.submissionByID(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if row == nil {
		s.writeError(w, r, newError(notFound, "submission_not_found", "提出が見つかりません"))
		return
	}
	if row.username != user.username && !user.isAdmin {
		s.writeError(w, r, newError(forbidden, "submission_forbidden", "この提出は閲覧できません"))
		return
	}
	published, _, err := s.privatePublished(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submission": serializeSubmission(*row, published)})
}
func (s *Server) GetSubmissionSource(w http.ResponseWriter, r *http.Request, id api.Uuid) {
	row, err := s.submissionSource(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if row == nil {
		s.writeError(w, r, newError(notFound, "source_not_found", "ソースコードが見つかりません"))
		return
	}
	published, _, err := s.privatePublished(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	user := authenticated(r)
	publicSource := published && row.representative.Valid && row.representative.String == id
	if !publicSource && (user == nil || (user.username != row.username && !user.isAdmin)) {
		s.writeError(w, r, newError(forbidden, "source_forbidden", "ソースコードはまだ公開されていません"))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename*=UTF-8''%s", encodeURIComponent(row.filename)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(row.content)
}

func (s *Server) ListAdminSubmissions(w http.ResponseWriter, r *http.Request) {
	if _, err := s.requireAdmin(r); err != nil {
		s.writeError(w, r, err)
		return
	}
	rows, err := s.allSubmissions(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	published, _, err := s.privatePublished(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submissions": serializeSubmissions(rows, published)})
}
func (s *Server) RetrySubmission(w http.ResponseWriter, r *http.Request, id api.Uuid) {
	admin, err := s.requireAdmin(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.retrySubmission(r.Context(), id); err == nil {
		err = s.audit(r.Context(), admin.username, "retry_submission", id, nil)
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}
func decodeJSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024+1))
	if err != nil || len(body) > 4*1024*1024 {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(target); err != nil {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です")
	}
	return nil
}
func (s *Server) DisqualifySubmission(w http.ResponseWriter, r *http.Request, id api.Uuid) {
	var body api.DisqualifySubmissionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		s.writeError(w, r, err)
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		s.writeError(w, r, newError(badRequest, "invalid_request", "リクエストの形式が不正です"))
		return
	}
	admin, err := s.requireAdmin(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.disqualifySubmission(r.Context(), id, reason); err == nil {
		err = s.audit(r.Context(), admin.username, "disqualify_submission", id, map[string]any{"reason": reason})
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OkResponse{Ok: true})
}
func (s *Server) ImportDatasets(w http.ResponseWriter, r *http.Request) {
	var manifest api.DatasetManifest
	if err := decodeJSON(r, &manifest); err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := validateManifest(manifest); err != nil {
		s.writeError(w, r, err)
		return
	}
	admin, err := s.requireAdmin(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if manifest.ContestId != s.config.ContestID {
		s.writeError(w, r, newError(badRequest, "contest_id_mismatch", "マニフェストのコンテストIDが一致しません"))
		return
	}
	for _, artifact := range manifest.Artifacts {
		if artifact.IsPublic {
			if err = s.r2.verifyObject(r.Context(), artifact.ObjectKey); err != nil {
				s.writeError(w, r, err)
				return
			}
		}
	}
	if err = s.importManifest(r.Context(), manifest); err == nil {
		err = s.audit(r.Context(), admin.username, "import_dataset_manifest", manifest.ContestId, map[string]any{"artifacts": len(manifest.Artifacts)})
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": len(manifest.Artifacts)})
}
func (s *Server) PublishPrivate(w http.ResponseWriter, r *http.Request) {
	admin, err := s.requireAdmin(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.publishPrivate(r.Context()); err == nil {
		err = s.audit(r.Context(), admin.username, "publish_private_leaderboard", s.config.ContestID, nil)
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"published": true})
}
func (s *Server) UnpublishPrivate(w http.ResponseWriter, r *http.Request) {
	admin, err := s.requireAdmin(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.unpublishPrivate(r.Context()); err == nil {
		err = s.audit(r.Context(), admin.username, "unpublish_private_leaderboard", s.config.ContestID, nil)
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"published": false})
}

var artifactIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var contestIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validateManifest(manifest api.DatasetManifest) error {
	invalid := func() error {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です")
	}
	if manifest.SchemaVersion != api.N1 || !contestIDPattern.MatchString(manifest.ContestId) || manifest.GeneratorRevision == "" || utf16Length(manifest.GeneratorRevision) > 128 || len(manifest.Artifacts) < 4 {
		return invalid()
	}
	if _, err := time.Parse(time.RFC3339Nano, manifest.GeneratedAt); err != nil {
		return invalid()
	}
	ids, keys, pairs := map[string]bool{}, map[string]bool{}, map[string]map[api.DatasetKind]bool{}
	hasPublic, hasPrivate := false, false
	for _, a := range manifest.Artifacts {
		if !artifactIDPattern.MatchString(a.Id) || (a.Kind != api.Input && a.Kind != api.Expected) || a.Label == "" || utf16Length(a.Label) > 128 || len(a.ObjectKey) > 1024 || !strings.HasPrefix(a.ObjectKey, "datasets/") || a.Rows <= 0 || a.CompressedBytes <= 0 || a.UncompressedBytes <= 0 || !shaPattern.MatchString(a.CompressedSha256) || !shaPattern.MatchString(a.UncompressedSha256) || ids[a.Id] || keys[a.ObjectKey] || !strings.HasSuffix(a.Id, "-"+string(a.Kind)) {
			return invalid()
		}
		for _, r := range a.ObjectKey {
			if r < 0x20 || r > 0x7e {
				return invalid()
			}
		}
		scope := "private"
		if a.IsPublic {
			scope = "public"
			hasPublic = true
		} else {
			hasPrivate = true
		}
		if !strings.HasPrefix(a.ObjectKey, fmt.Sprintf("datasets/%s/%s/", manifest.ContestId, scope)) {
			return invalid()
		}
		pair := fmt.Sprintf("%s:%d", scope, a.Rows)
		if pairs[pair] == nil {
			pairs[pair] = map[api.DatasetKind]bool{}
		}
		if pairs[pair][a.Kind] {
			return invalid()
		}
		pairs[pair][a.Kind] = true
		ids[a.Id] = true
		keys[a.ObjectKey] = true
	}
	if !hasPublic || !hasPrivate {
		return invalid()
	}
	for _, kinds := range pairs {
		if !kinds[api.Input] || !kinds[api.Expected] {
			return invalid()
		}
	}
	return nil
}

func (s *Server) StreamContest(w http.ResponseWriter, r *http.Request, params api.StreamContestParams) {
	if err := validateLeaderboardParams(params.Board, params.Language); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.streamChanges(w, r, "contest", func(ctx context.Context) (any, error) {
		published, publishedAt, err := s.privatePublished(ctx)
		if err != nil {
			return nil, err
		}
		participants, total, err := s.participationStats(ctx)
		if err != nil {
			return nil, err
		}
		rows, err := s.leaderboardRows(ctx, params.Language)
		if err != nil {
			return nil, err
		}
		board := api.Public
		if params.Board != nil && *params.Board == api.Private && published {
			board = api.Private
		}
		var value any = nil
		if publishedAt != nil {
			value = isoTime(*publishedAt)
		}
		return map[string]any{"contest": map[string]any{"privatePublishedAt": value, "participants": participants, "totalSubmissions": total}, "leaderboard": buildLeaderboard(rows, board, published)}, nil
	})
}
func (s *Server) StreamSubmissions(w http.ResponseWriter, r *http.Request) {
	user, err := s.requireUser(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.streamChanges(w, r, "submissions", func(ctx context.Context) (any, error) {
		rows, err := s.submissionsForUser(ctx, user.username)
		if err != nil {
			return nil, err
		}
		published, _, err := s.privatePublished(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"submissions": serializeSubmissions(rows, published)}, nil
	})
}
func (s *Server) streamChanges(w http.ResponseWriter, r *http.Request, event string, load func(context.Context) (any, error)) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.writeError(w, r, newError(infrastructure, "streaming_unavailable", "Streaming unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	previous := ""
	lastWrite := time.Now()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		value, err := load(r.Context())
		if err != nil {
			app := asAppError(err)
			body, _ := json.Marshal(map[string]any{"error": map[string]any{"code": app.code, "message": app.message}})
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", body)
			flusher.Flush()
			return
		}
		body, _ := json.Marshal(value)
		digest := fmt.Sprintf("%x", sha256.Sum256(body))
		if digest != previous {
			previous = digest
			lastWrite = time.Now()
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\nretry: 2000\n\n", lastWrite.UnixMilli(), event, body)
			flusher.Flush()
		} else if time.Since(lastWrite) >= 15*time.Second {
			lastWrite = time.Now()
			fmt.Fprint(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
