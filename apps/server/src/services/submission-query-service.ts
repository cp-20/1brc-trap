import { errAsync, ResultAsync } from "neverthrow";
import { serializeSubmission } from "../domain/submission.js";
import type { AuthUser } from "../middlewares/auth.js";
import type { ContestRepository } from "../repositories/contest-repository.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";
import { createResultCache } from "../utils/result-cache.js";

type SerializedSubmission = ReturnType<typeof serializeSubmission>;

export type SubmissionQueryService = ReturnType<
  typeof createSubmissionQueryService
>;

export function createSubmissionQueryService(
  submissions: SubmissionRepository,
  contest: ContestRepository,
) {
  const userListCache = createResultCache<SerializedSubmission[], AppError>(
    1_000,
  );

  return {
    listForUser(username: string) {
      return userListCache(username, () =>
        ResultAsync.combine([
          submissions.byUser(username),
          contest.privatePublished(),
        ]).map(([rows, privatePublished]) =>
          rows.map((row) => serializeSubmission(row, privatePublished)),
        ),
      );
    },
    getForUser(id: string, user: AuthUser) {
      return submissions.byId(id).andThen((row) => {
        if (!row) {
          return errAsync(
            new AppError(
              "not_found",
              "submission_not_found",
              "提出が見つかりません",
            ),
          );
        }
        if (row.username !== user.username && !user.isAdmin) {
          return errAsync(
            new AppError(
              "forbidden",
              "submission_forbidden",
              "この提出は閲覧できません",
            ),
          );
        }
        return contest
          .privatePublished()
          .map((privatePublished) =>
            serializeSubmission(row, privatePublished),
          );
      });
    },
    readSource(id: string, user: AuthUser | null) {
      return submissions.source(id).andThen((row) => {
        if (!row) {
          return errAsync(
            new AppError(
              "not_found",
              "source_not_found",
              "ソースコードが見つかりません",
            ),
          );
        }
        return contest.privatePublished().andThen((privatePublished) => {
          const publicSource =
            privatePublished && row.representative_submission_id === id;
          if (
            !publicSource &&
            (!user || (user.username !== row.username && !user.isAdmin))
          ) {
            return errAsync(
              new AppError(
                "forbidden",
                "source_forbidden",
                "ソースコードはまだ公開されていません",
              ),
            );
          }
          return ResultAsync.fromSafePromise(Promise.resolve(row));
        });
      });
    },
    listForAdmin() {
      return ResultAsync.combine([
        submissions.all(),
        contest.privatePublished(),
      ]).map(([rows, privatePublished]) =>
        rows.map((row) => serializeSubmission(row, privatePublished)),
      );
    },
  };
}
