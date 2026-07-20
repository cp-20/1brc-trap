package server

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
	"github.com/google/uuid"
)

type authUser struct {
	username  string
	isAdmin   bool
	method    api.AuthUserMethod
	tokenHash []byte
}

type submissionRow struct {
	id, username                                                 string
	executionKind, language, sourceFilename, artifactSHA256      sql.NullString
	status                                                       string
	publicVerdict, publicScoreNS, privateVerdict, privateScoreNS sql.NullString
	publicError, infrastructureError, disqualifiedReason         sql.NullString
	uploadStartedAt                                              time.Time
	queuedAt, startedAt, completedAt                             sql.NullTime
	queueAhead, submissionNumber                                 sql.NullInt64
}

const submissionColumns = `s.id, s.username, s.execution_kind, s.language, s.source_filename, s.artifact_sha256,
s.status, s.public_verdict, s.public_score_ns, s.private_verdict, s.private_score_ns,
s.public_error, s.infrastructure_error, s.disqualified_reason, s.upload_started_at, s.queued_at, s.started_at, s.completed_at`

type scanner interface{ Scan(...any) error }

func scanSubmission(row scanner, derived bool) (submissionRow, error) {
	var value submissionRow
	targets := []any{&value.id, &value.username, &value.executionKind, &value.language, &value.sourceFilename, &value.artifactSHA256,
		&value.status, &value.publicVerdict, &value.publicScoreNS, &value.privateVerdict, &value.privateScoreNS,
		&value.publicError, &value.infrastructureError, &value.disqualifiedReason, &value.uploadStartedAt, &value.queuedAt, &value.startedAt, &value.completedAt}
	if derived {
		targets = append(targets, &value.submissionNumber, &value.queueAhead)
	}
	return value, row.Scan(targets...)
}

func isoTime(value time.Time) string { return value.UTC().Format("2006-01-02T15:04:05.000Z") }
func nullString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
func nullTime(value sql.NullTime) any {
	if value.Valid {
		return isoTime(value.Time)
	}
	return nil
}
func stringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func serializeSubmission(row submissionRow, privatePublished bool) map[string]any {
	var public any
	if row.publicVerdict.Valid {
		verdict := row.publicVerdict.String
		if row.disqualifiedReason.Valid {
			verdict = string(api.Disqualified)
		}
		public = map[string]any{"verdict": verdict, "scoreNs": nullString(row.publicScoreNS), "error": nullString(row.publicError)}
	}
	result := map[string]any{
		"id": row.id, "username": row.username, "executionKind": nullString(row.executionKind), "language": nullString(row.language),
		"sourceFilename": nullString(row.sourceFilename), "artifactSha256": nullString(row.artifactSHA256), "status": row.status,
		"public": public, "infrastructureError": nullString(row.infrastructureError), "disqualifiedReason": nullString(row.disqualifiedReason),
		"uploadStartedAt": isoTime(row.uploadStartedAt), "queuedAt": nullTime(row.queuedAt), "startedAt": nullTime(row.startedAt), "completedAt": nullTime(row.completedAt),
		"queueAhead": nil, "submissionNumber": nil,
	}
	if row.status == string(api.SubmissionStatusQueued) {
		if row.queueAhead.Valid {
			result["queueAhead"] = row.queueAhead.Int64
		} else {
			result["queueAhead"] = int64(0)
		}
	}
	if row.submissionNumber.Valid {
		result["submissionNumber"] = row.submissionNumber.Int64
	}
	if privatePublished {
		var private any
		if row.privateVerdict.Valid {
			private = map[string]any{"verdict": row.privateVerdict.String, "scoreNs": nullString(row.privateScoreNS)}
		}
		result["private"] = private
	}
	return result
}

func (s *Server) ensureUser(ctx context.Context, username string) error {
	_, err := s.db.ExecContext(ctx, "INSERT IGNORE INTO users (username) VALUES (?)", username)
	if err != nil {
		return databaseError(err)
	}
	return nil
}

func (s *Server) userForToken(ctx context.Context, hash [32]byte) (*authUser, error) {
	var username string
	var stored []byte
	err := s.db.QueryRowContext(ctx, "SELECT username, token_hash FROM api_tokens WHERE token_hash = ? LIMIT 1", hash[:]).Scan(&username, &stored)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, databaseError(err)
	}
	if len(stored) != sha256.Size {
		return nil, nil
	}
	return &authUser{username: username, method: api.Token, tokenHash: stored}, nil
}

func (s *Server) touchToken(username string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP(6)
		WHERE username = ? AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP(6) - INTERVAL 5 MINUTE)`, username); err != nil {
		s.logger.Warn("failed to update access key timestamp", "username", username, "error", err)
	}
}

func (s *Server) issueAccessKey(ctx context.Context, username string) (api.AccessKeyResponse, error) {
	random := make([]byte, 32)
	if _, err := cryptorand.Read(random); err != nil {
		return api.AccessKeyResponse{}, newError(infrastructure, "token_generation_failed", "アクセスキーを生成できませんでした", err)
	}
	token := "1brc_" + base64.RawURLEncoding.EncodeToString(random)
	hash := sha256.Sum256([]byte(token))
	prefix := token[:13]
	_, err := s.db.ExecContext(ctx, `INSERT INTO api_tokens (username, token_hash, token_prefix) VALUES (?, ?, ?)
		ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash), token_prefix=VALUES(token_prefix), created_at=CURRENT_TIMESTAMP(6), last_used_at=NULL`, username, hash[:], prefix)
	if err != nil {
		return api.AccessKeyResponse{}, databaseError(err)
	}
	return api.AccessKeyResponse{AccessKey: token, Prefix: prefix}, nil
}

func (s *Server) revokeAccessKey(ctx context.Context, username string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM api_tokens WHERE username = ?", username); err != nil {
		return databaseError(err)
	}
	return nil
}

type reservation struct {
	id              string
	uploadStartedAt time.Time
}

func (s *Server) reserveSubmission(ctx context.Context, username string) (reservation, error) {
	value := reservation{id: uuid.NewString()}
	err := withTx(ctx, s.db, func(tx *sql.Tx) error {
		var singleton int
		if err := tx.QueryRowContext(ctx, "SELECT singleton_id FROM contest_state WHERE singleton_id = 1 FOR UPDATE").Scan(&singleton); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT IGNORE INTO users (username) VALUES (?)", username); err != nil {
			return err
		}
		var locked string
		if err := tx.QueryRowContext(ctx, "SELECT username FROM users WHERE username = ? FOR UPDATE", username).Scan(&locked); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "SELECT CURRENT_TIMESTAMP(6)").Scan(&value.uploadStartedAt); err != nil {
			return newError(infrastructure, "database_clock_unavailable", "現在時刻を取得できませんでした", err)
		}
		if value.uploadStartedAt.Before(s.config.ContestStartAt) {
			return newError(conflict, "contest_not_started", "コンテストはまだ始まっていません")
		}
		var active int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM submissions WHERE username = ? AND status IN ('uploading','queued','running')", username).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return newError(conflict, "active_submission", "アップロードまたは計測中の提出があります")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO submissions (id, username, status, upload_started_at) VALUES (?, ?, 'uploading', ?)", value.id, username, value.uploadStartedAt)
		return err
	})
	return value, err
}

func (s *Server) storeSource(ctx context.Context, id, filename, digest string, content []byte) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO submission_sources (submission_id, filename, sha256, content) VALUES (?, ?, ?, ?)", id, filename, digest, content)
	if err != nil {
		return databaseError(err)
	}
	return nil
}

func (s *Server) queueUpload(ctx context.Context, id string, kind api.ExecutionKind, language api.Language, filename, digest string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE submissions SET execution_kind=?, language=?, source_filename=?, artifact_sha256=?, status='queued', queued_at=CURRENT_TIMESTAMP(6)
		WHERE id=? AND status='uploading'`, kind, language, filename, digest, id)
	if err != nil {
		return databaseError(err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return databaseError(err)
	}
	if rows != 1 {
		return newError(conflict, "upload_expired", "アップロードの受付期限を超えました")
	}
	return nil
}

func (s *Server) discardUpload(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM submissions WHERE id=? AND status='uploading'", id)
	if err != nil {
		return databaseError(err)
	}
	return nil
}

func (s *Server) submissionsForUser(ctx context.Context, username string) ([]submissionRow, error) {
	query := `SELECT ` + submissionColumns + `,
	(SELECT COUNT(*) FROM submissions prior WHERE prior.username=s.username AND prior.status<>'rejected' AND (prior.upload_started_at<s.upload_started_at OR (prior.upload_started_at=s.upload_started_at AND prior.id<=s.id))) submission_number,
	CASE WHEN s.status='queued' THEN (SELECT COUNT(*) FROM submissions queued WHERE queued.status='running' OR (queued.status='queued' AND (queued.upload_started_at<s.upload_started_at OR (queued.upload_started_at=s.upload_started_at AND queued.id<s.id)))) ELSE NULL END queue_ahead
	FROM submissions s WHERE s.username=? AND s.status<>'rejected' ORDER BY s.upload_started_at DESC LIMIT 100`
	rows, err := s.db.QueryContext(ctx, query, username)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	return collectSubmissions(rows, true)
}

func (s *Server) allSubmissions(ctx context.Context) ([]submissionRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+submissionColumns+` FROM submissions s WHERE s.status<>'rejected' ORDER BY s.upload_started_at DESC LIMIT 500`)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	return collectSubmissions(rows, false)
}

func collectSubmissions(rows *sql.Rows, derived bool) ([]submissionRow, error) {
	result := []submissionRow{}
	for rows.Next() {
		value, err := scanSubmission(rows, derived)
		if err != nil {
			return nil, databaseError(err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(err)
	}
	return result, nil
}

func (s *Server) submissionByID(ctx context.Context, id string) (*submissionRow, error) {
	row, err := scanSubmission(s.db.QueryRowContext(ctx, `SELECT `+submissionColumns+` FROM submissions s WHERE s.id=? LIMIT 1`, id), false)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, databaseError(err)
	}
	return &row, nil
}

type sourceRow struct {
	username       string
	representative sql.NullString
	filename       string
	content        []byte
}

func (s *Server) submissionSource(ctx context.Context, id string) (*sourceRow, error) {
	var row sourceRow
	err := s.db.QueryRowContext(ctx, `SELECT s.username,u.representative_submission_id,ss.filename,ss.content FROM submissions s
		JOIN users u ON u.username=s.username JOIN submission_sources ss ON ss.submission_id=s.id WHERE s.id=? LIMIT 1`, id).Scan(&row.username, &row.representative, &row.filename, &row.content)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, databaseError(err)
	}
	return &row, nil
}

func (s *Server) privatePublished(ctx context.Context) (bool, *time.Time, error) {
	var value sql.NullTime
	err := s.db.QueryRowContext(ctx, "SELECT private_published_at FROM contest_state WHERE singleton_id=1").Scan(&value)
	if err == sql.ErrNoRows {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, databaseError(err)
	}
	if !value.Valid {
		return false, nil, nil
	}
	return true, &value.Time, nil
}

type leaderboardRecord struct {
	username, id, language, publicVerdict                   string
	publicScore, privateVerdict, privateScore, disqualified sql.NullString
	submittedAt                                             time.Time
}

func (s *Server) leaderboardRows(ctx context.Context, language *api.Language) ([]leaderboardRecord, error) {
	query := `SELECT u.username,s.id,s.language,s.public_verdict,s.public_score_ns,s.private_verdict,s.private_score_ns,s.disqualified_reason,s.upload_started_at
		FROM users u JOIN submissions s ON s.id=u.representative_submission_id WHERE s.public_verdict='accepted' AND s.upload_started_at<=?`
	args := []any{s.config.ContestEndAt}
	if language != nil {
		query += " AND s.language=?"
		args = append(args, *language)
	}
	query += " ORDER BY s.upload_started_at"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	result := []leaderboardRecord{}
	for rows.Next() {
		var r leaderboardRecord
		if err := rows.Scan(&r.username, &r.id, &r.language, &r.publicVerdict, &r.publicScore, &r.privateVerdict, &r.privateScore, &r.disqualified, &r.submittedAt); err != nil {
			return nil, databaseError(err)
		}
		if !s.config.Admins[r.username] {
			result = append(result, r)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(err)
	}
	return result, nil
}

func compareDecimal(left, right string) int {
	left = strings.TrimLeft(left, "0")
	right = strings.TrimLeft(right, "0")
	if left == "" {
		left = "0"
	}
	if right == "" {
		right = "0"
	}
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return strings.Compare(left, right)
}

func buildLeaderboard(rows []leaderboardRecord, board api.LeaderboardBoard, privatePublished bool) api.Leaderboard {
	ranks := func(private bool) map[string]int32 {
		accepted := make([]leaderboardRecord, 0, len(rows))
		for _, row := range rows {
			verdict, score := row.publicVerdict, row.publicScore
			if private {
				verdict = ""
				if row.privateVerdict.Valid {
					verdict = row.privateVerdict.String
				}
				score = row.privateScore
			}
			if !row.disqualified.Valid && verdict == string(api.Accepted) && score.Valid {
				accepted = append(accepted, row)
			}
		}
		sort.SliceStable(accepted, func(i, j int) bool {
			li, lj := accepted[i], accepted[j]
			var a, b string
			if private {
				a, b = li.privateScore.String, lj.privateScore.String
			} else {
				a, b = li.publicScore.String, lj.publicScore.String
			}
			if order := compareDecimal(a, b); order != 0 {
				return order < 0
			}
			return li.submittedAt.Before(lj.submittedAt)
		})
		out := map[string]int32{}
		for i, row := range accepted {
			out[row.id] = int32(i + 1)
		}
		return out
	}
	publicRanks, privateRanks := ranks(false), ranks(true)
	result := api.Leaderboard{Board: board, PrivatePublished: privatePublished, Ranked: []api.LeaderboardEntry{}, Disqualified: []api.LeaderboardEntry{}}
	for _, row := range rows {
		verdict := api.Verdict(row.publicVerdict)
		score := stringPointer(row.publicScore)
		rank, ok := publicRanks[row.id]
		if board == api.Private {
			verdict = api.InfrastructureError
			if row.privateVerdict.Valid {
				verdict = api.Verdict(row.privateVerdict.String)
			}
			score = stringPointer(row.privateScore)
			rank, ok = privateRanks[row.id]
		}
		if row.disqualified.Valid {
			verdict = api.Disqualified
			ok = false
		}
		entry := api.LeaderboardEntry{Username: row.username, SubmissionId: row.id, Language: api.Language(row.language), ScoreNs: score, Verdict: verdict, SubmittedAt: isoTime(row.submittedAt), SourceAvailable: privatePublished}
		if ok {
			value := rank
			entry.Rank = &value
		}
		if privatePublished {
			if pr, pok := publicRanks[row.id]; pok {
				if qr, qok := privateRanks[row.id]; qok {
					value := pr - qr
					entry.RankChange = &value
				}
			}
		}
		if entry.Rank == nil {
			result.Disqualified = append(result.Disqualified, entry)
		} else {
			result.Ranked = append(result.Ranked, entry)
		}
	}
	sort.SliceStable(result.Ranked, func(i, j int) bool { return *result.Ranked[i].Rank < *result.Ranked[j].Rank })
	return result
}

func (s *Server) participationStats(ctx context.Context) (int32, int32, error) {
	var participants, total int64
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT username),COUNT(*) FROM submissions WHERE status<>'rejected'").Scan(&participants, &total)
	if err != nil {
		return 0, 0, databaseError(err)
	}
	return int32(participants), int32(total), nil
}

func (s *Server) leaderboardReplay(ctx context.Context) ([]api.LeaderboardReplaySubmission, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,username,language,public_verdict,private_verdict,private_score_ns,disqualified_reason,upload_started_at FROM submissions WHERE public_verdict='accepted' AND upload_started_at<=? ORDER BY upload_started_at,id`, s.config.ContestEndAt)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	result := []api.LeaderboardReplaySubmission{}
	for rows.Next() {
		var id, user string
		var lang, pub, priv, score, disq sql.NullString
		var submitted time.Time
		if err := rows.Scan(&id, &user, &lang, &pub, &priv, &score, &disq, &submitted); err != nil {
			return nil, databaseError(err)
		}
		if s.config.Admins[user] {
			continue
		}
		item := api.LeaderboardReplaySubmission{SubmissionId: id, Username: user, SubmittedAt: isoTime(submitted), Disqualified: disq.Valid}
		if lang.Valid {
			v := api.Language(lang.String)
			item.Language = &v
		}
		if pub.Valid {
			v := api.Verdict(pub.String)
			item.PublicVerdict = &v
		}
		if priv.Valid {
			v := api.Verdict(priv.String)
			item.PrivateVerdict = &v
		}
		if score.Valid {
			v := score.String
			item.PrivateScoreNs = &v
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(err)
	}
	return result, nil
}

type datasetRow struct {
	id                                                                                         string
	kind                                                                                       api.DatasetKind
	label, objectKey, rows, compressedBytes, uncompressedBytes, compressedSHA, uncompressedSHA string
}

func (s *Server) publicDatasets(ctx context.Context) ([]datasetRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT artifact_id,kind,label,object_key,rows_count,compressed_bytes,uncompressed_bytes,compressed_sha256,uncompressed_sha256 FROM dataset_releases WHERE contest_id=? AND is_public=TRUE ORDER BY rows_count,kind`, s.config.ContestID)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	result := []datasetRow{}
	for rows.Next() {
		var r datasetRow
		if err := rows.Scan(&r.id, &r.kind, &r.label, &r.objectKey, &r.rows, &r.compressedBytes, &r.uncompressedBytes, &r.compressedSHA, &r.uncompressedSHA); err != nil {
			return nil, databaseError(err)
		}
		result = append(result, r)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(err)
	}
	return result, nil
}
func (s *Server) publicDataset(ctx context.Context, id string) (*datasetRow, error) {
	var r datasetRow
	err := s.db.QueryRowContext(ctx, `SELECT artifact_id,kind,label,object_key,rows_count,compressed_bytes,uncompressed_bytes,compressed_sha256,uncompressed_sha256 FROM dataset_releases WHERE contest_id=? AND artifact_id=? AND is_public=TRUE LIMIT 1`, s.config.ContestID, id).Scan(&r.id, &r.kind, &r.label, &r.objectKey, &r.rows, &r.compressedBytes, &r.uncompressedBytes, &r.compressedSHA, &r.uncompressedSHA)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, databaseError(err)
	}
	return &r, nil
}

func (s *Server) retrySubmission(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, "UPDATE submissions SET status='queued',infrastructure_error=NULL WHERE id=? AND status='infrastructure_error'", id)
	if err != nil {
		return databaseError(err)
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return newError(conflict, "retry_not_allowed", "再試行できる計測エラーの提出ではありません")
	}
	return nil
}
func (s *Server) disqualifySubmission(ctx context.Context, id, reason string) error {
	return withTx(ctx, s.db, func(tx *sql.Tx) error {
		var status string
		err := tx.QueryRowContext(ctx, "SELECT status FROM submissions WHERE id=? FOR UPDATE", id).Scan(&status)
		if err == sql.ErrNoRows {
			return newError(notFound, "submission_not_found", "提出が見つかりません")
		}
		if err != nil {
			return err
		}
		if status == "uploading" || status == "running" {
			return newError(conflict, "submission_active", "アップロード中または計測中の提出は完了後に失格にしてください")
		}
		reason = truncateUTF16(reason, 8192)
		_, err = tx.ExecContext(ctx, "UPDATE submissions SET disqualified_reason=?,status='disqualified' WHERE id=?", reason, id)
		return err
	})
}
func (s *Server) audit(ctx context.Context, admin, action, target string, detail any) error {
	var body any
	if detail != nil {
		encoded, err := json.Marshal(detail)
		if err != nil {
			return err
		}
		body = encoded
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO admin_audit (admin_username,action,target_id,detail_json) VALUES (?,?,?,?)", admin, action, target, body)
	if err != nil {
		return databaseError(err)
	}
	return nil
}

func (s *Server) importManifest(ctx context.Context, manifest api.DatasetManifest) error {
	generatedAt, err := time.Parse(time.RFC3339Nano, manifest.GeneratedAt)
	if err != nil {
		return newError(badRequest, "invalid_request", "リクエストの形式が不正です")
	}
	return withTx(ctx, s.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM dataset_releases WHERE contest_id=?", manifest.ContestId); err != nil {
			return err
		}
		for _, a := range manifest.Artifacts {
			if _, err := tx.ExecContext(ctx, `INSERT INTO dataset_releases (contest_id,artifact_id,kind,label,object_key,rows_count,compressed_bytes,uncompressed_bytes,compressed_sha256,uncompressed_sha256,is_public,generator_revision,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, manifest.ContestId, a.Id, a.Kind, a.Label, a.ObjectKey, a.Rows, a.CompressedBytes, a.UncompressedBytes, a.CompressedSha256, a.UncompressedSha256, a.IsPublic, manifest.GeneratorRevision, generatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Server) publishPrivate(ctx context.Context) error {
	return withTx(ctx, s.db, func(tx *sql.Tx) error {
		var published sql.NullTime
		if err := tx.QueryRowContext(ctx, "SELECT private_published_at FROM contest_state WHERE singleton_id=1 FOR UPDATE").Scan(&published); err != nil {
			return err
		}
		if published.Valid {
			return newError(conflict, "private_already_published", "Private結果はすでに公開されています")
		}
		var ended bool
		if err := tx.QueryRowContext(ctx, "SELECT CURRENT_TIMESTAMP(6) > ?", s.config.ContestEndAt).Scan(&ended); err != nil {
			return err
		}
		if !ended {
			return newError(conflict, "contest_not_ended", "コンテスト終了前には公開できません")
		}
		var active int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM submissions WHERE status IN ('uploading','queued','running')").Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return newError(conflict, "queue_not_drained", "未完了の提出があります")
		}
		_, err := tx.ExecContext(ctx, "UPDATE contest_state SET private_published_at=COALESCE(private_published_at,CURRENT_TIMESTAMP(6)) WHERE singleton_id=1")
		return err
	})
}
func (s *Server) unpublishPrivate(ctx context.Context) error {
	result, err := s.db.ExecContext(ctx, "UPDATE contest_state SET private_published_at=NULL WHERE singleton_id=1 AND private_published_at IS NOT NULL")
	if err != nil {
		return databaseError(err)
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return newError(conflict, "private_not_published", "Private結果は公開されていません")
	}
	return nil
}

func sanitizeDownloadID(id string, kind api.DatasetKind) string {
	return fmt.Sprintf("%s-%s", id, kind)
}
