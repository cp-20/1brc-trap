import { describe, expect, it } from "vitest";
import { serializeSubmission, type SubmissionRecord } from "./submission.js";

describe("submission visibility", () => {
  it("Private結果は公開操作が完了するまでresponse自体に含めない", () => {
    const hidden = serializeSubmission(submission(), false);
    const published = serializeSubmission(submission(), true);

    expect("private" in hidden).toBe(false);
    expect(published.private).toEqual({
      verdict: "accepted",
      scoreNs: "200",
    });
  });

  it("失格理由があれば過去のaccepted結果より失格判定を優先する", () => {
    const serialized = serializeSubmission(
      submission({ disqualified_reason: "embedded answer" }),
      true,
    );

    expect(serialized.public?.verdict).toBe("disqualified");
    expect(serialized.disqualifiedReason).toBe("embedded answer");
  });

  it("queueAheadはqueuedの提出にだけ公開する", () => {
    expect(
      serializeSubmission(
        submission({ status: "queued", queue_ahead: 2 }),
        false,
      ).queueAhead,
    ).toBe(2);
    expect(
      serializeSubmission(
        submission({ status: "completed", queue_ahead: 2 }),
        false,
      ).queueAhead,
    ).toBeNull();
  });
});

function submission(
  overrides: Partial<SubmissionRecord> = {},
): SubmissionRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "submission-id",
    username: "user",
    execution_kind: "typescript",
    language: "typescript",
    source_filename: "main.ts",
    artifact_sha256: "a".repeat(64),
    status: "completed",
    public_verdict: "accepted",
    public_score_ns: "100",
    private_verdict: "accepted",
    private_score_ns: "200",
    public_error: null,
    infrastructure_error: null,
    disqualified_reason: null,
    upload_started_at: now,
    queued_at: now,
    started_at: now,
    completed_at: now,
    created_at: now,
    ...overrides,
  };
}
