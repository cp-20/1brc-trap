import type { DatasetManifest } from "@1brc/domain";
import type { RowDataPacket } from "mysql2/promise";
import { err, ok } from "neverthrow";
import type { Database } from "../infrastructures/database.js";
import { AppError } from "../utils/errors.js";

export type AdminRepository = ReturnType<typeof createAdminRepository>;

export function createAdminRepository(database: Database) {
  return {
    audit(
      admin: string,
      action: string,
      target: string,
      detail?: Record<string, unknown>,
    ) {
      return database
        .execute(
          "INSERT INTO admin_audit (admin_username, action, target_id, detail_json) VALUES (?, ?, ?, ?)",
          [admin, action, target, detail ? JSON.stringify(detail) : null],
        )
        .map(() => undefined);
    },
    importDatasetManifest(manifest: DatasetManifest) {
      return database.transaction(async (connection) => {
        await connection.execute(
          "DELETE FROM dataset_releases WHERE contest_id = ?",
          [manifest.contestId],
        );
        for (const artifact of manifest.artifacts) {
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
        return ok(undefined);
      });
    },
    publishPrivateResults(contestEndAt: Date) {
      return database.transaction(async (connection) => {
        const [stateRows] = await connection.query<
          (RowDataPacket & { private_published_at: Date | null })[]
        >(
          "SELECT private_published_at FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
        );
        if (stateRows[0]?.private_published_at) {
          return err(
            new AppError(
              "conflict",
              "private_already_published",
              "Private結果はすでに公開されています",
            ),
          );
        }
        const [clockRows] = await connection.query<
          (RowDataPacket & { contest_ended: number })[]
        >("SELECT CURRENT_TIMESTAMP(6) > ? AS contest_ended", [contestEndAt]);
        if (!clockRows[0]?.contest_ended) {
          return err(
            new AppError(
              "conflict",
              "contest_not_ended",
              "コンテスト終了前には公開できません",
            ),
          );
        }
        const [activeRows] = await connection.query<
          (RowDataPacket & { active_count: number })[]
        >(
          "SELECT COUNT(*) AS active_count FROM submissions WHERE status IN ('uploading', 'queued', 'running', 'infrastructure_error')",
        );
        if (Number(activeRows[0]?.active_count ?? 0) > 0) {
          return err(
            new AppError(
              "conflict",
              "queue_not_drained",
              "未完了または再試行が必要な提出があります",
            ),
          );
        }
        await connection.execute(
          "UPDATE contest_state SET private_published_at = COALESCE(private_published_at, CURRENT_TIMESTAMP(6)) WHERE singleton_id = 1",
        );
        return ok(undefined);
      });
    },
    unpublishPrivateResults() {
      return database
        .execute(
          "UPDATE contest_state SET private_published_at = NULL WHERE singleton_id = 1 AND private_published_at IS NOT NULL",
        )
        .andThen((result) =>
          "affectedRows" in result && result.affectedRows === 1
            ? ok(undefined)
            : err(
                new AppError(
                  "conflict",
                  "private_not_published",
                  "Private結果は公開されていません",
                ),
              ),
        );
    },
  };
}
