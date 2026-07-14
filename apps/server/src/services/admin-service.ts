import type { DatasetManifest } from "@1brc/domain";
import { errAsync, ResultAsync } from "neverthrow";

import type { Config } from "../infrastructures/config.js";
import type { R2Signer } from "../infrastructures/r2-signer.js";
import type { AdminRepository } from "../repositories/admin-repository.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";

export type AdminService = ReturnType<typeof createAdminService>;

export function createAdminService(
  administration: AdminRepository,
  submissions: SubmissionRepository,
  config: Config,
  datasets: Pick<R2Signer, "verifyObject">,
) {
  return {
    retrySubmission(admin: string, id: string) {
      return submissions
        .retry(id)
        .andThen((retried) =>
          retried
            ? administration.audit(admin, "retry_submission", id)
            : errAsync(
                new AppError(
                  "conflict",
                  "retry_not_allowed",
                  "再試行できる計測エラーの提出ではありません",
                ),
              ),
        );
    },
    disqualifySubmission(admin: string, id: string, reason: string) {
      if (!reason.trim()) {
        return errAsync(
          new AppError(
            "bad_request",
            "reason_required",
            "失格理由を入力してください",
          ),
        );
      }
      return submissions.disqualify(id, reason).andThen(() =>
        administration.audit(admin, "disqualify_submission", id, {
          reason,
        }),
      );
    },
    importDatasetManifest(admin: string, manifest: DatasetManifest) {
      if (manifest.contestId !== config.CONTEST_ID) {
        return errAsync(
          new AppError(
            "bad_request",
            "contest_id_mismatch",
            "マニフェストのコンテストIDが一致しません",
          ),
        );
      }
      return ResultAsync.combine(
        manifest.artifacts
          .filter((artifact) => artifact.isPublic)
          .map((artifact) => datasets.verifyObject(artifact.objectKey)),
      )
        .andThen(() => administration.importDatasetManifest(manifest))
        .andThen(() =>
          administration.audit(
            admin,
            "import_dataset_manifest",
            manifest.contestId,
            { artifacts: manifest.artifacts.length },
          ),
        )
        .map(() => manifest.artifacts.length);
    },
    publishPrivateResults(admin: string) {
      return administration
        .publishPrivateResults(config.CONTEST_END_AT)
        .andThen(() =>
          administration.audit(
            admin,
            "publish_private_leaderboard",
            config.CONTEST_ID,
          ),
        );
    },
    unpublishPrivateResults(admin: string) {
      return administration
        .unpublishPrivateResults()
        .andThen(() =>
          administration.audit(
            admin,
            "unpublish_private_leaderboard",
            config.CONTEST_ID,
          ),
        );
    },
  };
}
