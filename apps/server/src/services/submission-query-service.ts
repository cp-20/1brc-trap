import { serializeSubmission } from "../domain/submission.js";
import type { AuthUser } from "../middlewares/auth.js";
import type { ContestRepository } from "../repositories/contest-repository.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";

export type SubmissionQueryService = ReturnType<
  typeof createSubmissionQueryService
>;

export function createSubmissionQueryService(
  submissions: SubmissionRepository,
  contest: ContestRepository,
) {
  return {
    async listForUser(username: string) {
      const [rows, privatePublished] = await Promise.all([
        submissions.byUser(username),
        contest.privatePublished(),
      ]);
      return rows.map((row) => serializeSubmission(row, privatePublished));
    },
    async getForUser(id: string, user: AuthUser) {
      const row = await submissions.byId(id);
      if (!row)
        throw new AppError(
          "not_found",
          "submission_not_found",
          "提出が見つかりません",
        );
      if (row.username !== user.username && !user.isAdmin) {
        throw new AppError(
          "forbidden",
          "submission_forbidden",
          "この提出は閲覧できません",
        );
      }
      return serializeSubmission(row, await contest.privatePublished());
    },
    async readSource(id: string, user: AuthUser | null) {
      const row = await submissions.source(id);
      if (!row)
        throw new AppError(
          "not_found",
          "source_not_found",
          "ソースコードが見つかりません",
        );
      const publicSource =
        (await contest.privatePublished()) &&
        row.representative_submission_id === id;
      if (
        !publicSource &&
        (!user || (user.username !== row.username && !user.isAdmin))
      ) {
        throw new AppError(
          "forbidden",
          "source_forbidden",
          "ソースコードはまだ公開されていません",
        );
      }
      return row;
    },
    async listForAdmin() {
      const [rows, privatePublished] = await Promise.all([
        submissions.all(),
        contest.privatePublished(),
      ]);
      return rows.map((row) => serializeSubmission(row, privatePublished));
    },
  };
}
