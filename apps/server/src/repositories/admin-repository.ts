import type { DatasetManifest } from "@1brc/contracts";
import type { RowDataPacket } from "mysql2/promise";
import type { Config } from "../infrastructures/config.js";
import type { Database } from "../infrastructures/database.js";
import { AppError } from "../utils/errors.js";

export type AdminRepository = ReturnType<typeof createAdminRepository>;

export function createAdminRepository(database: Database) {
  return {
    async issueAccessKey(username: string, hash: Buffer, prefix: string) {
      const result = await database.execute(
        `INSERT INTO api_tokens (username, token_hash, token_prefix)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), token_prefix = VALUES(token_prefix),
         created_at = CURRENT_TIMESTAMP(6), last_used_at = NULL`,
        [username, hash, prefix],
      );
      if (result.isErr()) throw result.error;
    },
    async revokeAccessKey(username: string) {
      const result = await database.execute(
        "DELETE FROM api_tokens WHERE username = ?",
        [username],
      );
      if (result.isErr()) throw result.error;
    },
    async audit(
      admin: string,
      action: string,
      target: string,
      detail?: Record<string, unknown>,
    ) {
      const result = await database.execute(
        "INSERT INTO admin_audit (admin_username, action, target_id, detail_json) VALUES (?, ?, ?, ?)",
        [admin, action, target, detail ? JSON.stringify(detail) : null],
      );
      if (result.isErr()) throw result.error;
    },
    async importDatasetManifest(manifest: DatasetManifest, config: Config) {
      const result = await database.transaction(async (connection) => {
        await connection.execute(
          "DELETE FROM dataset_releases WHERE contest_id = ?",
          [config.CONTEST_ID],
        );
        for (const artifact of manifest.artifacts) {
          if (
            artifact.isPublic &&
            !artifact.objectKey.startsWith(
              `datasets/${config.CONTEST_ID}/public/`,
            )
          ) {
            throw new AppError(
              "bad_request",
              "invalid_public_object",
              "公開データのオブジェクトキーが不正です",
            );
          }
          await connection.execute(
            `INSERT INTO dataset_releases
             (contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
              uncompressed_bytes, compressed_sha256, uncompressed_sha256, is_public,
              generator_revision, generated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              manifest.contestId,
              artifact.id,
              artifact.kind,
              artifact.label,
              artifact.objectKey,
              artifact.rows,
              artifact.compressedBytes,
              artifact.uncompressedBytes,
              artifact.compressedSha256,
              artifact.uncompressedSha256,
              artifact.isPublic,
              manifest.generatorRevision,
              new Date(manifest.generatedAt),
            ],
          );
        }
      });
      if (result.isErr()) throw result.error;
    },
    async publishPrivateResults(config: Config) {
      const result = await database.transaction(async (connection) => {
        const [stateRows] = await connection.query<
          (RowDataPacket & { private_published_at: Date | null })[]
        >(
          "SELECT private_published_at FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
        );
        if (stateRows[0]?.private_published_at) {
          throw new AppError(
            "conflict",
            "private_already_published",
            "Private結果はすでに公開されています",
          );
        }
        const [clockRows] = await connection.query<
          (RowDataPacket & { contest_ended: number })[]
        >("SELECT CURRENT_TIMESTAMP(6) > ? AS contest_ended", [
          config.CONTEST_END_AT,
        ]);
        if (!clockRows[0]?.contest_ended) {
          throw new AppError(
            "conflict",
            "contest_not_ended",
            "コンテスト終了前には公開できません",
          );
        }
        const [activeRows] = await connection.query<
          (RowDataPacket & { active_count: number })[]
        >(
          "SELECT COUNT(*) AS active_count FROM submissions WHERE status IN ('uploading', 'queued', 'running', 'infrastructure_error')",
        );
        if (Number(activeRows[0]?.active_count ?? 0) > 0) {
          throw new AppError(
            "conflict",
            "queue_not_drained",
            "未完了または再試行が必要な提出があります",
          );
        }
        await connection.execute(
          "UPDATE contest_state SET private_published_at = COALESCE(private_published_at, CURRENT_TIMESTAMP(6)) WHERE singleton_id = 1",
        );
        await connection.execute(
          `DELETE ss FROM submission_sources ss
            JOIN submissions s ON s.id = ss.submission_id
            JOIN users u ON u.username = s.username
           WHERE u.representative_submission_id IS NULL OR ss.submission_id <> u.representative_submission_id`,
        );
      });
      if (result.isErr()) throw result.error;
    },
    async unpublishPrivateResults() {
      const result = await database.execute(
        "UPDATE contest_state SET private_published_at = NULL WHERE singleton_id = 1 AND private_published_at IS NOT NULL",
      );
      if (result.isErr()) throw result.error;
      if (
        !("affectedRows" in result.value) ||
        result.value.affectedRows !== 1
      ) {
        throw new AppError(
          "conflict",
          "private_not_published",
          "Private結果は公開されていません",
        );
      }
    },
  };
}
