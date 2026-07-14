import type {
  ExecutionKind,
  Language,
  SubmissionStatus,
  Verdict,
} from "@1brc/domain";

export type SubmissionRecord = {
  id: string;
  username: string;
  execution_kind: ExecutionKind | null;
  language: Language | null;
  source_filename: string | null;
  artifact_sha256: string | null;
  status: SubmissionStatus;
  public_verdict: Verdict | null;
  public_score_ns: string | null;
  private_verdict: Verdict | null;
  private_score_ns: string | null;
  public_error: string | null;
  infrastructure_error: string | null;
  disqualified_reason: string | null;
  upload_started_at: Date;
  queued_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  queue_ahead?: number | null;
  submission_number?: number | null;
};

export type SourceRecord = {
  username: string;
  representative_submission_id: string | null;
  filename: string;
  content: Uint8Array;
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
