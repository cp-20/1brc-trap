package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	_ "net/http/pprof"
	"os"
	"time"

	"github.com/cp-20/1blc-trap/apps/server/migrations"
)

func Run(ctx context.Context) error {
	config, err := LoadConfig()
	if err != nil {
		return err
	}
	logger := newLogger(config.LogLevel)
	slog.SetDefault(logger)
	db, err := OpenDatabase(config)
	if err != nil {
		return err
	}
	defer db.Close()
	if err = migrations.Run(ctx, db); err != nil {
		return err
	}
	logger.Info("MariaDB migration completed")
	runner, err := newRunnerClient(config)
	if err != nil {
		return err
	}
	r2, err := newR2Client(ctx, config)
	if err != nil {
		return err
	}
	application := New(config, db, runner, r2, logger)
	if err = application.recoverInterrupted(ctx); err != nil {
		return err
	}
	benchmarkWorker := newWorker(application)
	benchmarkWorker.Start(ctx)
	defer benchmarkWorker.Stop()
	httpServer := &http.Server{Addr: fmt.Sprintf("0.0.0.0:%d", config.Port), Handler: application.Handler(), ReadHeaderTimeout: 10 * time.Second}
	serverError := make(chan error, 1)
	go func() {
		err := httpServer.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serverError <- err
	}()
	if config.ProfilingSecret != "" {
		go startProfiler(config, logger)
	}
	logger.Info("1BRC APIを起動しました", "port", config.Port, "environmentId", config.BenchmarkEnvironmentID)
	select {
	case <-ctx.Done():
		logger.Info("1BRC APIを停止します", "signal", ctx.Err())
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-serverError:
		return err
	case err := <-benchmarkWorker.Done():
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return fmt.Errorf("benchmark worker stopped unexpectedly: %w", err)
	}
}

func Migrate(ctx context.Context) error {
	config, err := LoadConfig()
	if err != nil {
		return err
	}
	db, err := OpenDatabase(config)
	if err != nil {
		return err
	}
	defer db.Close()
	return migrations.Run(ctx, db)
}
func newLogger(level string) *slog.Logger {
	var parsed slog.Level
	switch level {
	case "debug":
		parsed = slog.LevelDebug
	case "warn":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	default:
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parsed}))
}
func startProfiler(config Config, logger *slog.Logger) {
	prefix := "/" + config.ProfilingSecret
	server := &http.Server{Addr: fmt.Sprintf("0.0.0.0:%d", config.ProfilingPort), Handler: http.StripPrefix(prefix, http.DefaultServeMux), ReadHeaderTimeout: 5 * time.Second}
	logger.Info("Go profilerを起動しました", "url", fmt.Sprintf("http://0.0.0.0:%d%s/debug/pprof/", config.ProfilingPort, prefix))
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("profiler stopped", "error", err)
	}
}
