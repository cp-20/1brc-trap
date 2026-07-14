import type { submissions } from "../infrastructures/schema.js";

type Submission = typeof submissions.$inferSelect;

export type SubmissionRecord = Pick<
  Submission,
  | "id"
  | "username"
  | "execution_kind"
  | "language"
  | "source_filename"
  | "artifact_sha256"
  | "status"
  | "public_verdict"
  | "public_score_ns"
  | "private_verdict"
  | "private_score_ns"
  | "public_error"
  | "infrastructure_error"
  | "disqualified_reason"
  | "upload_started_at"
  | "queued_at"
  | "started_at"
  | "completed_at"
  | "created_at"
> & {
  queue_ahead?: number | null;
  submission_number?: number | null;
};

export function serializeSubmission(
  row: SubmissionRecord,
  privatePublished: boolean,
) {
  return {
    id: row.id,
    username: row.username,
    executionKind: row.execution_kind,
    language: row.language,
    sourceFilename: row.source_filename,
    artifactSha256: row.artifact_sha256,
    status: row.status,
    public: row.public_verdict
      ? {
          verdict: row.disqualified_reason
            ? "disqualified"
            : row.public_verdict,
          scoreNs: row.public_score_ns,
          error: row.public_error,
        }
      : null,
    ...(privatePublished
      ? {
          private: row.private_verdict
            ? { verdict: row.private_verdict, scoreNs: row.private_score_ns }
            : null,
        }
      : {}),
    infrastructureError: row.infrastructure_error,
    disqualifiedReason: row.disqualified_reason,
    uploadStartedAt: row.upload_started_at.toISOString(),
    queuedAt: row.queued_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    queueAhead: row.status === "queued" ? Number(row.queue_ahead ?? 0) : null,
    submissionNumber:
      row.submission_number === undefined || row.submission_number === null
        ? null
        : Number(row.submission_number),
  };
}
