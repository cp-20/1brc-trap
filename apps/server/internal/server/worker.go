package server

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/internal/api"
)

type worker struct {
	server *Server
	logger *slog.Logger
	cancel context.CancelFunc
	done   chan error
	once   sync.Once
}
type benchmarkJob struct {
	id, username   string
	kind, language sql.NullString
}

func newWorker(server *Server) *worker {
	return &worker{server: server, logger: server.logger, done: make(chan error, 1)}
}
func (w *worker) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel
	go func() { w.done <- w.supervise(ctx); close(w.done) }()
}
func (w *worker) Stop() {
	w.once.Do(func() {
		if w.cancel != nil {
			w.cancel()
		}
	})
	<-w.done
}
func (w *worker) Done() <-chan error { return w.done }

func (s *Server) recoverInterrupted(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM submissions WHERE status='running'")
	if err != nil {
		return databaseError(err)
	}
	var runs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return databaseError(err)
		}
		runs = append(runs, id)
	}
	rows.Close()
	for _, id := range runs {
		if err := s.runner.cancel(ctx, id); err != nil {
			return newError(infrastructure, "runner_unavailable", "計測環境に接続できませんでした。しばらく待ってから再度提出してください", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE submissions SET status='infrastructure_error',infrastructure_error='worker restarted during benchmark' WHERE status='running'"); err != nil {
		return databaseError(err)
	}
	rows, err = s.db.QueryContext(ctx, "SELECT id FROM submissions WHERE status='uploading'")
	if err != nil {
		return databaseError(err)
	}
	var uploads []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return databaseError(err)
		}
		uploads = append(uploads, id)
	}
	rows.Close()
	if _, err := s.db.ExecContext(ctx, "DELETE FROM submissions WHERE status='uploading'"); err != nil {
		return databaseError(err)
	}
	for _, id := range uploads {
		if err := s.runner.cleanup(ctx, id); err != nil {
			s.logger.Warn("failed to clean interrupted upload", "submissionId", id, "error", err)
		}
	}
	return nil
}

func (w *worker) supervise(ctx context.Context) error {
	waitingLogged := false
	for ctx.Err() == nil {
		conn, err := w.server.db.Conn(ctx)
		if err != nil {
			return err
		}
		var acquired sql.NullInt64
		err = conn.QueryRowContext(ctx, "SELECT GET_LOCK('1brc_benchmark_worker', 0)").Scan(&acquired)
		if err != nil {
			conn.Close()
			return err
		}
		if acquired.Valid && acquired.Int64 == 1 {
			err = w.runAsLeader(ctx)
			_, _ = conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK('1brc_benchmark_worker')")
			conn.Close()
			if err != nil {
				return err
			}
			continue
		}
		conn.Close()
		if !waitingLogged {
			w.logger.Info("benchmark worker is running in another replica")
			waitingLogged = true
		}
		if !waitContext(ctx, 2*time.Second) {
			break
		}
	}
	return ctx.Err()
}
func (w *worker) runAsLeader(ctx context.Context) error {
	if err := w.validateEnvironment(ctx); err != nil {
		return err
	}
	w.logger.Info("benchmark worker started", "environmentId", w.server.config.BenchmarkEnvironmentID)
	for ctx.Err() == nil {
		if _, err := w.server.db.ExecContext(ctx, "UPDATE contest_state SET worker_heartbeat_at=CURRENT_TIMESTAMP(6) WHERE singleton_id=1"); err != nil {
			w.logger.Error("failed to update worker heartbeat", "error", err)
			waitContext(ctx, 2*time.Second)
			continue
		}
		job, err := w.claimNext(ctx)
		if err != nil {
			w.logger.Error("failed to claim queue", "error", err)
			waitContext(ctx, 2*time.Second)
			continue
		}
		if job == nil {
			waitContext(ctx, 2*time.Second)
			continue
		}
		if !job.kind.Valid || !job.language.Valid {
			w.retryUntilStopped(ctx, func() error {
				return w.markInfrastructureFailure(ctx, job.id, "queued submission is missing execution metadata")
			}, job.id)
			continue
		}
		w.logger.Info("benchmark started", "submissionId", job.id, "username", job.username, "language", job.language.String)
		result, runErr := w.server.runner.run(ctx, job.id, api.ExecutionKind(job.kind.String))
		if runErr != nil {
			w.logger.Error("benchmark infrastructure failure", "submissionId", job.id, "error", runErr)
			w.retryUntilStopped(ctx, func() error {
				return w.markInfrastructureFailure(ctx, job.id, "計測環境に接続できませんでした。しばらく待ってから再度提出してください")
			}, job.id)
			continue
		}
		w.retryUntilStopped(ctx, func() error { return w.storeResult(ctx, *job, result.Public, result.Private) }, job.id)
		if err := w.server.runner.cleanup(ctx, job.id); err != nil {
			w.logger.Warn("failed to clean runner artifact", "submissionId", job.id, "error", err)
		}
		var privateVerdict any
		if result.Private != nil {
			privateVerdict = result.Private.Verdict
		}
		w.logger.Info("benchmark completed", "submissionId", job.id, "publicVerdict", result.Public.Verdict, "privateVerdict", privateVerdict)
	}
	return ctx.Err()
}
func (w *worker) validateEnvironment(ctx context.Context) error {
	return withTx(ctx, w.server.db, func(tx *sql.Tx) error {
		var existing sql.NullString
		if err := tx.QueryRowContext(ctx, "SELECT benchmark_environment_id FROM contest_state WHERE singleton_id=1 FOR UPDATE").Scan(&existing); err != nil {
			return err
		}
		if existing.Valid && existing.String != w.server.config.BenchmarkEnvironmentID {
			return newError(infrastructure, "benchmark_environment_mismatch", fmt.Sprintf("benchmark environment mismatch: database=%s, configured=%s", existing.String, w.server.config.BenchmarkEnvironmentID))
		}
		_, err := tx.ExecContext(ctx, "UPDATE contest_state SET benchmark_environment_id=? WHERE singleton_id=1", w.server.config.BenchmarkEnvironmentID)
		return err
	})
}
func (w *worker) claimNext(ctx context.Context) (*benchmarkJob, error) {
	var job benchmarkJob
	found := false
	err := withTx(ctx, w.server.db, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, "SELECT id,username,execution_kind,language FROM submissions WHERE status='queued' ORDER BY upload_started_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").Scan(&job.id, &job.username, &job.kind, &job.language)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		_, err = tx.ExecContext(ctx, "UPDATE submissions SET status='running',started_at=CURRENT_TIMESTAMP(6),infrastructure_error=NULL WHERE id=?", job.id)
		return err
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return &job, nil
}
func (w *worker) markInfrastructureFailure(ctx context.Context, id, message string) error {
	message = truncateUTF16(message, 8192)
	_, err := w.server.db.ExecContext(ctx, "UPDATE submissions SET status='infrastructure_error',infrastructure_error=? WHERE id=? AND status='running'", message, id)
	if err != nil {
		return databaseError(err)
	}
	return nil
}
func (w *worker) storeResult(ctx context.Context, job benchmarkJob, public benchmarkResult, private *benchmarkResult) error {
	return withTx(ctx, w.server.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM benchmark_runs WHERE submission_id=?", job.id); err != nil {
			return err
		}
		if err := insertBenchmarkRuns(ctx, tx, job.id, "public", public); err != nil {
			return err
		}
		if private != nil {
			if err := insertBenchmarkRuns(ctx, tx, job.id, "private", *private); err != nil {
				return err
			}
		}
		var privateVerdict, privateScore any
		if private != nil {
			privateVerdict = private.Verdict
			privateScore = private.MedianNS
		}
		if _, err := tx.ExecContext(ctx, `UPDATE submissions SET status='completed',public_verdict=?,public_score_ns=?,public_error=?,private_verdict=?,private_score_ns=?,completed_at=CURRENT_TIMESTAMP(6) WHERE id=?`, public.Verdict, public.MedianNS, public.Error, privateVerdict, privateScore, job.id); err != nil {
			return err
		}
		if public.Verdict == api.Accepted {
			_, err := tx.ExecContext(ctx, `UPDATE users u JOIN submissions candidate ON candidate.id=? LEFT JOIN submissions current ON current.id=u.representative_submission_id SET u.representative_submission_id=candidate.id WHERE u.username=? AND candidate.upload_started_at<=? AND (current.id IS NULL OR current.upload_started_at<candidate.upload_started_at OR (current.upload_started_at=candidate.upload_started_at AND current.id<candidate.id))`, job.id, job.username, w.server.config.ContestEndAt)
			if err != nil {
				return err
			}
		}
		return nil
	})
}
func insertBenchmarkRuns(ctx context.Context, tx *sql.Tx, id, dataset string, result benchmarkResult) error {
	durations := result.DurationsNS
	if durations == nil {
		durations = []string{""}
	}
	for index, duration := range durations {
		var value any = duration
		if duration == "" {
			value = nil
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO benchmark_runs (submission_id,dataset_kind,attempt,verdict,duration_ns) VALUES (?,?,?,?,?)", id, dataset, index+1, result.Verdict, value); err != nil {
			return err
		}
	}
	return nil
}
func (w *worker) retryUntilStopped(ctx context.Context, operation func() error, id string) {
	for ctx.Err() == nil {
		if err := operation(); err == nil {
			return
		} else {
			w.logger.Error("failed to persist benchmark state; retrying", "submissionId", id, "error", err)
		}
		if !waitContext(ctx, 2*time.Second) {
			return
		}
	}
}
func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
