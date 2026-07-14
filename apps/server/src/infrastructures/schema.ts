import {
  executionKinds,
  languages,
  submissionStatuses,
  verdicts,
} from "@1brc/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  datetime,
  foreignKey,
  index,
  json,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const datasetKinds = ["input", "expected"] as const;
const benchmarkDatasetKinds = ["public", "private"] as const;
const binaryBuffer = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "binary(32)",
});
const longblob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "longblob",
});
const unsignedBigint = customType<{
  data: string;
  driverData: string | number;
}>({
  dataType: () => "bigint unsigned",
  fromDriver: String,
});
const asciiVarchar = customType<{
  data: string;
  driverData: string;
  config: { length: number };
  configRequired: true;
}>({
  dataType: ({ length }) =>
    `varchar(${length}) character set ascii collate ascii_bin`,
});
const asciiObjectKey = customType<{ data: string; driverData: string }>({
  dataType: () => "varchar(1024) character set ascii collate ascii_bin",
});
const createdAt = () =>
  datetime({ fsp: 6 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`);
const updatedAt = () =>
  timestamp({ fsp: 6 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`)
    .onUpdateNow();

export const users = mysqlTable("users", {
  username: asciiVarchar({ length: 64 }).primaryKey(),
  representative_submission_id: char({ length: 36 }),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const apiTokens = mysqlTable(
  "api_tokens",
  {
    username: asciiVarchar({ length: 64 }).primaryKey(),
    token_hash: binaryBuffer().notNull(),
    token_prefix: varchar({ length: 16 }).notNull(),
    created_at: createdAt(),
    last_used_at: datetime({ fsp: 6 }),
  },
  (table) => [
    uniqueIndex("uq_api_tokens_token_hash").on(table.token_hash),
    foreignKey({
      name: "fk_api_tokens_user",
      columns: [table.username],
      foreignColumns: [users.username],
    }).onDelete("cascade"),
  ],
);

export const submissions = mysqlTable(
  "submissions",
  {
    id: char({ length: 36 }).primaryKey(),
    username: asciiVarchar({ length: 64 }).notNull(),
    execution_kind: varchar({ length: 24, enum: executionKinds }),
    language: varchar({ length: 24, enum: languages }),
    source_filename: varchar({ length: 255 }),
    artifact_sha256: char({ length: 64 }),
    status: varchar({ length: 32, enum: submissionStatuses }).notNull(),
    public_verdict: varchar({ length: 32, enum: verdicts }),
    public_score_ns: unsignedBigint(),
    private_verdict: varchar({ length: 32, enum: verdicts }),
    private_score_ns: unsignedBigint(),
    public_error: text(),
    infrastructure_error: text(),
    disqualified_reason: text(),
    upload_started_at: datetime({ fsp: 6 }).notNull(),
    queued_at: datetime({ fsp: 6 }),
    started_at: datetime({ fsp: 6 }),
    completed_at: datetime({ fsp: 6 }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "fk_submissions_user",
      columns: [table.username],
      foreignColumns: [users.username],
    }).onDelete("cascade"),
    index("idx_submission_queue").on(
      table.status,
      table.upload_started_at,
      table.id,
    ),
    index("idx_submission_user_created").on(table.username, table.created_at),
  ],
);

export const submissionSources = mysqlTable(
  "submission_sources",
  {
    submission_id: char({ length: 36 }).primaryKey(),
    filename: varchar({ length: 255 }).notNull(),
    sha256: char({ length: 64 }).notNull(),
    content: longblob().notNull(),
    created_at: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "fk_submission_sources_submission",
      columns: [table.submission_id],
      foreignColumns: [submissions.id],
    }).onDelete("cascade"),
  ],
);

export const benchmarkRuns = mysqlTable(
  "benchmark_runs",
  {
    id: bigint({ mode: "number", unsigned: true }).autoincrement().primaryKey(),
    submission_id: char({ length: 36 }).notNull(),
    dataset_kind: varchar({
      length: 16,
      enum: benchmarkDatasetKinds,
    }).notNull(),
    attempt: tinyint({ unsigned: true }).notNull(),
    verdict: varchar({ length: 32, enum: verdicts }).notNull(),
    duration_ns: unsignedBigint(),
    created_at: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "fk_benchmark_runs_submission",
      columns: [table.submission_id],
      foreignColumns: [submissions.id],
    }).onDelete("cascade"),
    uniqueIndex("uq_benchmark_attempt").on(
      table.submission_id,
      table.dataset_kind,
      table.attempt,
    ),
  ],
);

export const datasetReleases = mysqlTable(
  "dataset_releases",
  {
    contest_id: varchar({ length: 128 }).notNull(),
    artifact_id: varchar({ length: 64 }).notNull(),
    kind: varchar({ length: 16, enum: datasetKinds }).notNull(),
    label: varchar({ length: 128 }).notNull(),
    object_key: asciiObjectKey().notNull(),
    rows_count: unsignedBigint().notNull(),
    compressed_bytes: unsignedBigint().notNull(),
    uncompressed_bytes: unsignedBigint().notNull(),
    compressed_sha256: char({ length: 64 }).notNull(),
    uncompressed_sha256: char({ length: 64 }).notNull(),
    is_public: boolean().notNull(),
    generator_revision: varchar({ length: 128 }).notNull(),
    generated_at: datetime({ fsp: 6 }).notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.contest_id, table.artifact_id] }),
    uniqueIndex("uq_dataset_object_key").on(table.object_key),
  ],
);

export const contestState = mysqlTable(
  "contest_state",
  {
    singleton_id: tinyint().primaryKey(),
    private_published_at: datetime({ fsp: 6 }),
    worker_heartbeat_at: datetime({ fsp: 6 }),
    benchmark_environment_id: varchar({ length: 128 }),
    updated_at: updatedAt(),
  },
  (table) => [check("chk_singleton_id", sql`${table.singleton_id} = 1`)],
);

export const adminAudit = mysqlTable("admin_audit", {
  id: bigint({ mode: "number", unsigned: true }).autoincrement().primaryKey(),
  admin_username: asciiVarchar({ length: 64 }).notNull(),
  action: varchar({ length: 64 }).notNull(),
  target_id: varchar({ length: 128 }),
  detail_json: json().$type<Record<string, unknown>>(),
  created_at: createdAt(),
});
