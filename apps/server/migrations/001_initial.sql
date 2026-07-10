CREATE TABLE IF NOT EXISTS users (
  username VARCHAR(64) PRIMARY KEY,
  representative_submission_id CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS api_tokens (
  username VARCHAR(64) PRIMARY KEY,
  token_hash BINARY(32) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_used_at DATETIME(6) NULL,
  CONSTRAINT fk_api_tokens_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS submissions (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  execution_kind VARCHAR(24) NULL,
  language VARCHAR(24) NULL,
  source_filename VARCHAR(255) NULL,
  artifact_sha256 CHAR(64) NULL,
  status VARCHAR(32) NOT NULL,
  public_verdict VARCHAR(32) NULL,
  public_score_ns BIGINT UNSIGNED NULL,
  private_verdict VARCHAR(32) NULL,
  private_score_ns BIGINT UNSIGNED NULL,
  public_error TEXT NULL,
  infrastructure_error TEXT NULL,
  disqualified_reason TEXT NULL,
  upload_started_at DATETIME(6) NOT NULL,
  queued_at DATETIME(6) NULL,
  started_at DATETIME(6) NULL,
  completed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_submissions_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
  INDEX idx_submission_queue (status, upload_started_at, id),
  INDEX idx_submission_user_created (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS submission_sources (
  submission_id CHAR(36) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  content LONGBLOB NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_submission_sources_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  submission_id CHAR(36) NOT NULL,
  dataset_kind VARCHAR(16) NOT NULL,
  attempt TINYINT UNSIGNED NOT NULL,
  verdict VARCHAR(32) NOT NULL,
  duration_ns BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_benchmark_runs_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_benchmark_attempt (submission_id, dataset_kind, attempt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dataset_releases (
  contest_id VARCHAR(128) NOT NULL,
  artifact_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  label VARCHAR(128) NOT NULL,
  object_key VARCHAR(1024) NOT NULL,
  rows_count BIGINT UNSIGNED NOT NULL,
  compressed_bytes BIGINT UNSIGNED NOT NULL,
  uncompressed_bytes BIGINT UNSIGNED NOT NULL,
  compressed_sha256 CHAR(64) NOT NULL,
  uncompressed_sha256 CHAR(64) NOT NULL,
  is_public BOOLEAN NOT NULL,
  generator_revision VARCHAR(128) NOT NULL,
  generated_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (contest_id, artifact_id),
  UNIQUE KEY uq_dataset_object_key (object_key(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS contest_state (
  singleton_id TINYINT PRIMARY KEY,
  private_published_at DATETIME(6) NULL,
  worker_heartbeat_at DATETIME(6) NULL,
  benchmark_environment_id VARCHAR(128) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_singleton_id CHECK (singleton_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT IGNORE INTO contest_state (singleton_id) VALUES (1);

CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_username VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_id VARCHAR(128) NULL,
  detail_json JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
