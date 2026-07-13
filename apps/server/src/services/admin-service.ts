import type { DatasetManifest } from "@1brc/contracts";
import type { Config } from "../infrastructures/config.js";
import type { AdminRepository } from "../repositories/admin-repository.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { issueAccessKey } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";

export type AdminService = ReturnType<typeof createAdminService>;

export function createAdminService(
  administration: AdminRepository,
  submissions: SubmissionRepository,
  config: Config,
) {
  return {
    async issueAccessKey(username: string) {
      const issued = issueAccessKey();
      await administration.issueAccessKey(username, issued.hash, issued.prefix);
      return { accessKey: issued.token, prefix: issued.prefix };
    },
    revokeAccessKey: (username: string) =>
      administration.revokeAccessKey(username),
    async retrySubmission(admin: string, id: string) {
      if (!(await submissions.retry(id))) {
        throw new AppError(
          "conflict",
          "retry_not_allowed",
          "再試行できる計測エラーの提出ではありません",
        );
      }
      await administration.audit(admin, "retry_submission", id);
    },
    async disqualifySubmission(admin: string, id: string, reason: string) {
      if (!reason.trim())
        throw new AppError(
          "bad_request",
          "reason_required",
          "失格理由を入力してください",
        );
      await submissions.disqualify(id, reason);
      await administration.audit(admin, "disqualify_submission", id, {
        reason,
      });
    },
    async importDatasetManifest(admin: string, manifest: DatasetManifest) {
      if (manifest.contestId !== config.CONTEST_ID)
        throw new AppError(
          "bad_request",
          "contest_id_mismatch",
          "マニフェストのコンテストIDが一致しません",
        );
      await administration.importDatasetManifest(manifest, config);
      await administration.audit(
        admin,
        "import_dataset_manifest",
        manifest.contestId,
        { artifacts: manifest.artifacts.length },
      );
      return manifest.artifacts.length;
    },
    async publishPrivateResults(admin: string) {
      await administration.publishPrivateResults(config);
      await administration.audit(
        admin,
        "publish_private_leaderboard",
        config.CONTEST_ID,
      );
    },
    async unpublishPrivateResults(admin: string) {
      await administration.unpublishPrivateResults();
      await administration.audit(
        admin,
        "unpublish_private_leaderboard",
        config.CONTEST_ID,
      );
    },
  };
}
