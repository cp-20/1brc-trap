package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed *.sql
var files embed.FS

func Run(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var acquired int
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK('1brc_schema_migrations', 60)").Scan(&acquired); err != nil {
		return err
	}
	if acquired != 1 {
		return fmt.Errorf("timed out waiting for the database migration lock")
	}
	defer conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK('1brc_schema_migrations')")
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS onebrc_migrations (name varchar(255) PRIMARY KEY, applied_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`); err != nil {
		return err
	}
	entries, err := files.ReadDir(".")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		var exists int
		if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM onebrc_migrations WHERE name = ?", entry.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			continue
		}
		body, err := files.ReadFile(entry.Name())
		if err != nil {
			return err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, statement := range strings.Split(string(body), "--> statement-breakpoint") {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			if _, err = tx.ExecContext(ctx, statement); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration %s: %w", entry.Name(), err)
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO onebrc_migrations (name) VALUES (?)", entry.Name()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
