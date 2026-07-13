import type { RowDataPacket } from "mysql2/promise";
import type { LeaderboardRecord } from "../domain/leaderboard.js";
import type { Database } from "../infrastructures/database.js";

export type ContestStateRow = RowDataPacket & {
  private_published_at: Date | null;
  worker_heartbeat_at: Date | null;
  benchmark_environment_id: string | null;
};

export type DatasetRow = RowDataPacket & {
  contest_id: string;
  artifact_id: string;
  kind: "input" | "expected";
  label: string;
  object_key: string;
  rows_count: string;
  compressed_bytes: string;
  uncompressed_bytes: string;
  compressed_sha256: string;
  uncompressed_sha256: string;
};

type LeaderboardRow = RowDataPacket & LeaderboardRecord;

export type ContestRepository = ReturnType<typeof createContestRepository>;

export function createContestRepository(database: Database) {
  return {
    async state() {
      const result = await database.query<ContestStateRow[]>(
        "SELECT * FROM contest_state WHERE singleton_id = 1",
      );
      if (result.isErr()) throw result.error;
      return result.value[0] ?? null;
    },
    async privatePublished() {
      const result = await database.query<ContestStateRow[]>(
        "SELECT private_published_at FROM contest_state WHERE singleton_id = 1",
      );
      if (result.isErr()) throw result.error;
      return Boolean(result.value[0]?.private_published_at);
    },
    async participationStats() {
      const result = await database.query<
        (RowDataPacket & {
          participant_count: number;
          submission_count: number;
        })[]
      >(
        `SELECT COUNT(DISTINCT username) AS participant_count,
                COUNT(*) AS submission_count
           FROM submissions
          WHERE status <> 'rejected'`,
      );
      if (result.isErr()) throw result.error;
      return {
        participants: Number(result.value[0]?.participant_count ?? 0),
        totalSubmissions: Number(result.value[0]?.submission_count ?? 0),
      };
    },
    async leaderboard(language?: string) {
      const result = await database.query<LeaderboardRow[]>(
        `SELECT u.username, s.id AS submission_id, s.language,
                s.public_verdict, s.public_score_ns, s.private_verdict, s.private_score_ns,
                s.disqualified_reason, s.upload_started_at AS submitted_at
           FROM users u
           JOIN submissions s ON s.id = u.representative_submission_id
          WHERE s.public_verdict = 'accepted'
            AND (? IS NULL OR s.language = ?)
          ORDER BY s.upload_started_at ASC`,
        [language ?? null, language ?? null],
      );
      if (result.isErr()) throw result.error;
      return result.value;
    },
    async publicDatasets(contestId: string) {
      const result = await database.query<DatasetRow[]>(
        `SELECT contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
                uncompressed_bytes, compressed_sha256, uncompressed_sha256
           FROM dataset_releases WHERE contest_id = ? AND is_public = TRUE ORDER BY rows_count, kind`,
        [contestId],
      );
      if (result.isErr()) throw result.error;
      return result.value;
    },
    async publicDataset(contestId: string, artifactId: string) {
      const result = await database.query<DatasetRow[]>(
        `SELECT contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
                uncompressed_bytes, compressed_sha256, uncompressed_sha256
           FROM dataset_releases
          WHERE contest_id = ? AND artifact_id = ? AND is_public = TRUE LIMIT 1`,
        [contestId, artifactId],
      );
      if (result.isErr()) throw result.error;
      return result.value[0] ?? null;
    },
  };
}
