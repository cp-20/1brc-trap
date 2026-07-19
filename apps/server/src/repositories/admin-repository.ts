import { activeSubmissionStatuses, type DatasetManifest } from "@1brc/domain";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { err, ok } from "neverthrow";

import type { Database } from "../infrastructures/database.js";
import {
  adminAudit,
  contestState,
  datasetReleases,
  submissions,
} from "../infrastructures/schema.js";
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
        .result(
          database.orm.insert(adminAudit).values({
            admin_username: admin,
            action,
            target_id: target,
            detail_json: detail ?? null,
          }),
        )
        .map(() => undefined);
    },
    importDatasetManifest(manifest: DatasetManifest) {
      return database.transaction(async (transaction) => {
        await transaction
          .delete(datasetReleases)
          .where(eq(datasetReleases.contest_id, manifest.contestId));
        await transaction.insert(datasetReleases).values(
          manifest.artifacts.map((artifact) => ({
            contest_id: manifest.contestId,
            artifact_id: artifact.id,
            kind: artifact.kind,
            label: artifact.label,
            object_key: artifact.objectKey,
            rows_count: String(artifact.rows),
            compressed_bytes: String(artifact.compressedBytes),
            uncompressed_bytes: String(artifact.uncompressedBytes),
            compressed_sha256: artifact.compressedSha256,
            uncompressed_sha256: artifact.uncompressedSha256,
            is_public: artifact.isPublic,
            generator_revision: manifest.generatorRevision,
            generated_at: new Date(manifest.generatedAt),
          })),
        );
        return ok(undefined);
      });
    },
    publishPrivateResults(contestEndAt: Date) {
      return database.transaction(async (transaction) => {
        const [state] = await transaction
          .select({
            private_published_at: contestState.private_published_at,
          })
          .from(contestState)
          .where(eq(contestState.singleton_id, 1))
          .for("update");
        if (state?.private_published_at) {
          return err(
            new AppError(
              "conflict",
              "private_already_published",
              "Private結果はすでに公開されています",
            ),
          );
        }
        const [clock] = await transaction
          .select({
            contest_ended: sql<boolean>`CURRENT_TIMESTAMP(6) > ${contestEndAt}`,
          })
          .from(sql`DUAL`);
        if (!clock?.contest_ended) {
          return err(
            new AppError(
              "conflict",
              "contest_not_ended",
              "コンテスト終了前には公開できません",
            ),
          );
        }
        const [active] = await transaction
          .select({ active_count: count() })
          .from(submissions)
          .where(inArray(submissions.status, activeSubmissionStatuses));
        if ((active?.active_count ?? 0) > 0) {
          return err(
            new AppError(
              "conflict",
              "queue_not_drained",
              "未完了の提出があります",
            ),
          );
        }
        await transaction
          .update(contestState)
          .set({
            private_published_at: sql`COALESCE(${contestState.private_published_at}, CURRENT_TIMESTAMP(6))`,
          })
          .where(eq(contestState.singleton_id, 1));
        return ok(undefined);
      });
    },
    unpublishPrivateResults() {
      return database
        .result(
          database.orm
            .update(contestState)
            .set({ private_published_at: null })
            .where(
              and(
                eq(contestState.singleton_id, 1),
                isNotNull(contestState.private_published_at),
              ),
            ),
        )
        .andThen((result) =>
          result[0].affectedRows === 1
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
