-- Drizzle Kitの生成DDLを依存順に並べ、旧migration適用済みDBにも安全に適用できるbaselineにしている。
CREATE TABLE IF NOT EXISTS `users` (
	`username` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`representative_submission_id` char(36),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_username` PRIMARY KEY(`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_tokens` (
	`username` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`token_hash` binary(32) NOT NULL,
	`token_prefix` varchar(16) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`last_used_at` datetime(6),
	CONSTRAINT `api_tokens_username` PRIMARY KEY(`username`),
	CONSTRAINT `uq_api_tokens_token_hash` UNIQUE(`token_hash`),
	CONSTRAINT `fk_api_tokens_user` FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON DELETE cascade ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `submissions` (
	`id` char(36) NOT NULL,
	`username` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`execution_kind` varchar(24),
	`language` varchar(24),
	`source_filename` varchar(255),
	`artifact_sha256` char(64),
	`status` varchar(32) NOT NULL,
	`public_verdict` varchar(32),
	`public_score_ns` bigint unsigned,
	`private_verdict` varchar(32),
	`private_score_ns` bigint unsigned,
	`public_error` text,
	`infrastructure_error` text,
	`disqualified_reason` text,
	`upload_started_at` datetime(6) NOT NULL,
	`queued_at` datetime(6),
	`started_at` datetime(6),
	`completed_at` datetime(6),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_submissions_user` FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON DELETE cascade ON UPDATE no action,
	INDEX `idx_submission_queue` (`status`,`upload_started_at`,`id`),
	INDEX `idx_submission_user_created` (`username`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `submission_sources` (
	`submission_id` char(36) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`sha256` char(64) NOT NULL,
	`content` longblob NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `submission_sources_submission_id` PRIMARY KEY(`submission_id`),
	CONSTRAINT `fk_submission_sources_submission` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE cascade ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `benchmark_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`submission_id` char(36) NOT NULL,
	`dataset_kind` varchar(16) NOT NULL,
	`attempt` tinyint unsigned NOT NULL,
	`verdict` varchar(32) NOT NULL,
	`duration_ns` bigint unsigned,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `benchmark_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_benchmark_attempt` UNIQUE(`submission_id`,`dataset_kind`,`attempt`),
	CONSTRAINT `fk_benchmark_runs_submission` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE cascade ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dataset_releases` (
	`contest_id` varchar(128) NOT NULL,
	`artifact_id` varchar(64) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`label` varchar(128) NOT NULL,
	`object_key` varchar(1024) character set ascii collate ascii_bin NOT NULL,
	`rows_count` bigint unsigned NOT NULL,
	`compressed_bytes` bigint unsigned NOT NULL,
	`uncompressed_bytes` bigint unsigned NOT NULL,
	`compressed_sha256` char(64) NOT NULL,
	`uncompressed_sha256` char(64) NOT NULL,
	`is_public` boolean NOT NULL,
	`generator_revision` varchar(128) NOT NULL,
	`generated_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `dataset_releases_contest_id_artifact_id_pk` PRIMARY KEY(`contest_id`,`artifact_id`),
	CONSTRAINT `uq_dataset_object_key` UNIQUE(`object_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `contest_state` (
	`singleton_id` tinyint NOT NULL,
	`private_published_at` datetime(6),
	`worker_heartbeat_at` datetime(6),
	`benchmark_environment_id` varchar(128),
	`updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contest_state_singleton_id` PRIMARY KEY(`singleton_id`),
	CONSTRAINT `chk_singleton_id` CHECK(`contest_state`.`singleton_id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `admin_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_username` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`action` varchar(64) NOT NULL,
	`target_id` varchar(128),
	`detail_json` json,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `admin_audit_id` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
