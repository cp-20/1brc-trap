import { randomUUID } from "node:crypto";

import {
  activeSubmissionStatuses,
  hasContestStarted,
  isSubmissionOpen,
  type ExecutionKind,
  type Language,
} from "@1brc/domain";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { err, ok } from "neverthrow";

import type { Config } from "../infrastructures/config.js";
import type { Database } from "../infrastructures/database.js";
import {
  contestState,
  submissionSources,
  submissions,
  users,
} from "../infrastructures/schema.js";
import { AppError } from "../utils/errors.js";

export type SubmissionRepository = ReturnType<
  typeof createSubmissionRepository
>;

export function createSubmissionRepository(database: Database) {
  return {
    reserve(username: string, config: Config) {
      const id = randomUUID();
      return database.transaction(async (transaction) => {
        await transaction
          .select({ singleton_id: contestState.singleton_id })
          .from(contestState)
          .where(eq(contestState.singleton_id, 1))
          .for("update");
        await transaction.insert(users).ignore().values({ username });
        await transaction
          .select({ username: users.username })
          .from(users)
          .where(eq(users.username, username))
          .for("update");
        const [clock] = await transaction
          .select({
            now: sql<Date>`CURRENT_TIMESTAMP(6)`.mapWith(
              submissions.upload_started_at,
            ),
          })
          .from(sql`DUAL`);
        if (!clock)
          return err(
            new AppError(
              "infrastructure",
              "database_clock_unavailable",
              "現在時刻を取得できませんでした",
            ),
          );
        const schedule = {
          startAt: config.CONTEST_START_AT,
          endAt: config.CONTEST_END_AT,
        };
        if (!hasContestStarted(schedule, clock.now))
          return err(
            new AppError(
              "conflict",
              "contest_not_started",
              "コンテストはまだ始まっていません",
            ),
          );
        if (!isSubmissionOpen(schedule, clock.now))
          return err(
            new AppError(
              "contest_closed",
              "contest_closed",
              "提出受付は終了しました",
            ),
          );
        const [active] = await transaction
          .select({ active_count: sql<number>`COUNT(*)` })
          .from(submissions)
          .where(
            and(
              eq(submissions.username, username),
              inArray(submissions.status, activeSubmissionStatuses),
            ),
          );
        if ((active?.active_count ?? 0) > 0) {
          return err(
            new AppError(
              "conflict",
              "active_submission",
              "アップロードまたは計測中の提出があります",
            ),
          );
        }
        await transaction.insert(submissions).values({
          id,
          username,
          status: "uploading",
          upload_started_at: clock.now,
        });
        return ok({ id, uploadStartedAt: clock.now.toISOString() });
      });
    },
    storeSource(id: string, filename: string, sha256: string, content: Buffer) {
      return database
        .result(
          database.orm.insert(submissionSources).values({
            submission_id: id,
            filename,
            sha256,
            content,
          }),
        )
        .map(() => undefined);
    },
    queueUpload(
      id: string,
      executionKind: ExecutionKind,
      language: Language,
      sourceFilename: string,
      artifactSha256: string,
    ) {
      return database
        .result(
          database.orm
            .update(submissions)
            .set({
              execution_kind: executionKind,
              language,
              source_filename: sourceFilename,
              artifact_sha256: artifactSha256,
              status: "queued",
              queued_at: sql`CURRENT_TIMESTAMP(6)`,
            })
            .where(
              and(eq(submissions.id, id), eq(submissions.status, "uploading")),
            ),
        )
        .andThen((result) =>
          result[0].affectedRows === 1
            ? ok(undefined)
            : err(
                new AppError(
                  "conflict",
                  "upload_expired",
                  "アップロードの受付期限を超えました",
                ),
              ),
        );
    },
    discardUpload(id: string) {
      return database
        .result(
          database.orm
            .delete(submissions)
            .where(
              and(eq(submissions.id, id), eq(submissions.status, "uploading")),
            ),
        )
        .map(() => undefined);
    },
    discardInterruptedUploads() {
      return database.transaction(async (transaction) => {
        const rows = await transaction
          .select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.status, "uploading"));
        await transaction
          .delete(submissions)
          .where(eq(submissions.status, "uploading"));
        return ok(rows.map(({ id }) => id));
      });
    },
    byUser(username: string) {
      const prior = alias(submissions, "prior_submission");
      const queued = alias(submissions, "queued_submission");
      return database.result(
        database.orm
          .select({
            ...getTableColumns(submissions),
            submission_number: sql<number>`(
              SELECT COUNT(*) FROM ${submissions} AS ${prior}
               WHERE ${and(
                 eq(prior.username, submissions.username),
                 ne(prior.status, "rejected"),
                 or(
                   lt(prior.upload_started_at, submissions.upload_started_at),
                   and(
                     eq(prior.upload_started_at, submissions.upload_started_at),
                     lte(prior.id, submissions.id),
                   ),
                 ),
               )}
            )`.mapWith(Number),
            queue_ahead: sql<number | null>`CASE
              WHEN ${submissions.status} = 'queued' THEN (
                SELECT COUNT(*) FROM ${submissions} AS ${queued}
                 WHERE ${or(
                   eq(queued.status, "running"),
                   and(
                     eq(queued.status, "queued"),
                     or(
                       lt(
                         queued.upload_started_at,
                         submissions.upload_started_at,
                       ),
                       and(
                         eq(
                           queued.upload_started_at,
                           submissions.upload_started_at,
                         ),
                         lt(queued.id, submissions.id),
                       ),
                     ),
                   ),
                 )}
              ) ELSE NULL END`.mapWith(Number),
          })
          .from(submissions)
          .where(
            and(
              eq(submissions.username, username),
              ne(submissions.status, "rejected"),
            ),
          )
          .orderBy(desc(submissions.upload_started_at))
          .limit(100),
      );
    },
    byId(id: string) {
      return database
        .result(
          database.orm
            .select()
            .from(submissions)
            .where(eq(submissions.id, id))
            .limit(1),
        )
        .map((rows) => rows[0] ?? null);
    },
    source(id: string) {
      return database
        .result(
          database.orm
            .select({
              username: submissions.username,
              representative_submission_id: users.representative_submission_id,
              filename: submissionSources.filename,
              content: submissionSources.content,
            })
            .from(submissions)
            .innerJoin(users, eq(users.username, submissions.username))
            .innerJoin(
              submissionSources,
              eq(submissionSources.submission_id, submissions.id),
            )
            .where(eq(submissions.id, id))
            .limit(1),
        )
        .map((rows) => rows[0] ?? null);
    },
    all() {
      return database.result(
        database.orm
          .select()
          .from(submissions)
          .where(ne(submissions.status, "rejected"))
          .orderBy(desc(submissions.upload_started_at))
          .limit(500),
      );
    },
    retry(id: string) {
      return database
        .result(
          database.orm
            .update(submissions)
            .set({ status: "queued", infrastructure_error: null })
            .where(
              and(
                eq(submissions.id, id),
                eq(submissions.status, "infrastructure_error"),
              ),
            ),
        )
        .map((result) => result[0].affectedRows === 1);
    },
    disqualify(id: string, reason: string) {
      return database.transaction(async (transaction) => {
        const [submission] = await transaction
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, id))
          .for("update");
        if (!submission)
          return err(
            new AppError(
              "not_found",
              "submission_not_found",
              "提出が見つかりません",
            ),
          );
        if (["uploading", "running"].includes(submission.status)) {
          return err(
            new AppError(
              "conflict",
              "submission_active",
              "アップロード中または計測中の提出は完了後に失格にしてください",
            ),
          );
        }
        await transaction
          .update(submissions)
          .set({
            disqualified_reason: reason.slice(0, 8192),
            status: "disqualified",
          })
          .where(eq(submissions.id, id));
        return ok(undefined);
      });
    },
  };
}
