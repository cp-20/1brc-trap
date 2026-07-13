import { randomUUID } from "node:crypto";
import type { ExecutionKind, Language } from "@1brc/contracts";
import type { RowDataPacket } from "mysql2/promise";
import type { SourceRecord, SubmissionRecord } from "../domain/submission.js";
import type { Config } from "../infrastructures/config.js";
import type { Database } from "../infrastructures/database.js";
import { AppError } from "../utils/errors.js";

type ClockRow = RowDataPacket & { now: Date; is_open: number };
type ActiveRow = RowDataPacket & { active_count: number };
type SubmissionRow = RowDataPacket & SubmissionRecord;
type SourceRow = RowDataPacket & SourceRecord;

export type SubmissionReservation = { id: string; uploadStartedAt: string };
export type SubmissionRepository = ReturnType<
  typeof createSubmissionRepository
>;

export function createSubmissionRepository(database: Database) {
  return {
    async reserve(
      username: string,
      config: Config,
    ): Promise<SubmissionReservation> {
      const id = randomUUID();
      const result = await database.transaction(async (connection) => {
        await connection.query(
          "SELECT singleton_id FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
        );
        await connection.execute(
          "INSERT IGNORE INTO users (username) VALUES (?)",
          [username],
        );
        await connection.query(
          "SELECT username FROM users WHERE username = ? FOR UPDATE",
          [username],
        );
        const [clockRows] = await connection.query<ClockRow[]>(
          "SELECT CURRENT_TIMESTAMP(6) AS now, CURRENT_TIMESTAMP(6) <= ? AS is_open",
          [config.CONTEST_END_AT],
        );
        const clock = clockRows[0];
        if (!clock?.is_open)
          throw new AppError(
            "contest_closed",
            "contest_closed",
            "提出受付は終了しました",
          );
        if (clock.now < config.CONTEST_START_AT)
          throw new AppError(
            "conflict",
            "contest_not_started",
            "コンテストはまだ始まっていません",
          );
        const [activeRows] = await connection.query<ActiveRow[]>(
          "SELECT COUNT(*) AS active_count FROM submissions WHERE username = ? AND status IN ('uploading', 'queued', 'running')",
          [username],
        );
        if (Number(activeRows[0]?.active_count ?? 0) > 0) {
          throw new AppError(
            "conflict",
            "active_submission",
            "アップロードまたは計測中の提出があります",
          );
        }
        await connection.execute(
          "INSERT INTO submissions (id, username, status, upload_started_at) VALUES (?, ?, 'uploading', ?)",
          [id, username, clock.now],
        );
        return { id, uploadStartedAt: clock.now.toISOString() };
      });
      if (result.isErr()) throw result.error;
      return result.value;
    },
    async storeSource(
      id: string,
      filename: string,
      sha256: string,
      content: Buffer,
    ) {
      const result = await database.execute(
        "INSERT INTO submission_sources (submission_id, filename, sha256, content) VALUES (?, ?, ?, ?)",
        [id, filename, sha256, content],
      );
      if (result.isErr()) throw result.error;
    },
    async queueUpload(
      id: string,
      executionKind: ExecutionKind,
      language: Language,
      sourceFilename: string,
      artifactSha256: string,
    ) {
      const result = await database.execute(
        `UPDATE submissions
           SET execution_kind = ?, language = ?, source_filename = ?, artifact_sha256 = ?,
               status = 'queued', queued_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND status = 'uploading'`,
        [executionKind, language, sourceFilename, artifactSha256, id],
      );
      if (result.isErr()) throw result.error;
      if (
        !("affectedRows" in result.value) ||
        result.value.affectedRows !== 1
      ) {
        throw new AppError(
          "conflict",
          "upload_expired",
          "アップロードの受付期限を超えました",
        );
      }
    },
    async discardUpload(id: string) {
      const result = await database.execute(
        "DELETE FROM submissions WHERE id = ? AND status = 'uploading'",
        [id],
      );
      if (result.isErr()) throw result.error;
    },
    async byUser(username: string) {
      const result = await database.query<SubmissionRow[]>(
        `SELECT s.*,
                (SELECT COUNT(*) FROM submissions n
                  WHERE n.username = s.username AND n.status <> 'rejected'
                    AND (n.upload_started_at < s.upload_started_at OR
                         (n.upload_started_at = s.upload_started_at AND n.id <= s.id)))
                  AS submission_number,
                CASE WHEN s.status = 'queued' THEN (
                  SELECT COUNT(*) FROM submissions q
                   WHERE q.status = 'running'
                      OR (q.status = 'queued' AND
                          (q.upload_started_at < s.upload_started_at OR
                           (q.upload_started_at = s.upload_started_at AND q.id < s.id)))
                ) ELSE NULL END AS queue_ahead
           FROM submissions s
          WHERE s.username = ? AND s.status <> 'rejected'
          ORDER BY s.upload_started_at DESC LIMIT 100`,
        [username],
      );
      if (result.isErr()) throw result.error;
      return result.value;
    },
    async byId(id: string) {
      const result = await database.query<SubmissionRow[]>(
        "SELECT * FROM submissions WHERE id = ? LIMIT 1",
        [id],
      );
      if (result.isErr()) throw result.error;
      return result.value[0] ?? null;
    },
    async source(id: string) {
      const result = await database.query<SourceRow[]>(
        `SELECT s.username, u.representative_submission_id, ss.filename, ss.content
           FROM submissions s JOIN users u ON u.username = s.username
           JOIN submission_sources ss ON ss.submission_id = s.id WHERE s.id = ? LIMIT 1`,
        [id],
      );
      if (result.isErr()) throw result.error;
      return result.value[0] ?? null;
    },
    async all() {
      const result = await database.query<SubmissionRow[]>(
        "SELECT * FROM submissions WHERE status <> 'rejected' ORDER BY upload_started_at DESC LIMIT 500",
      );
      if (result.isErr()) throw result.error;
      return result.value;
    },
    async retry(id: string) {
      const result = await database.execute(
        "UPDATE submissions SET status = 'queued', infrastructure_error = NULL WHERE id = ? AND status = 'infrastructure_error'",
        [id],
      );
      if (result.isErr()) throw result.error;
      return "affectedRows" in result.value && result.value.affectedRows === 1;
    },
    async disqualify(id: string, reason: string) {
      const result = await database.transaction(async (connection) => {
        const [rows] = await connection.query<
          (RowDataPacket & { status: string })[]
        >("SELECT status FROM submissions WHERE id = ? FOR UPDATE", [id]);
        if (!rows[0])
          throw new AppError(
            "not_found",
            "submission_not_found",
            "提出が見つかりません",
          );
        if (["uploading", "running"].includes(rows[0].status)) {
          throw new AppError(
            "conflict",
            "submission_active",
            "アップロード中または計測中の提出は完了後に失格にしてください",
          );
        }
        await connection.execute(
          "UPDATE submissions SET disqualified_reason = ?, status = 'disqualified' WHERE id = ?",
          [reason.slice(0, 8192), id],
        );
      });
      if (result.isErr()) throw result.error;
    },
  };
}
