package server

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
)

func OpenDatabase(config Config) (*sql.DB, error) {
	dsnConfig := mysql.Config{
		User: config.DBUser, Passwd: config.DBPassword,
		Net: "tcp", Addr: fmt.Sprintf("%s:%d", config.DBHost, config.DBPort), DBName: config.DBName,
		ParseTime: true, Loc: time.UTC, Collation: "utf8mb4_bin", AllowNativePasswords: true,
		Params: map[string]string{"charset": "utf8mb4", "time_zone": "'+00:00'"},
	}
	dsn := dsnConfig.FormatDSN()
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(10)
	return db, nil
}

func withTx(ctx context.Context, db *sql.DB, operation func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return transactionError(err)
	}
	if err = operation(tx); err != nil {
		_ = tx.Rollback()
		return transactionError(err)
	}
	if err = tx.Commit(); err != nil {
		return transactionError(err)
	}
	return nil
}
