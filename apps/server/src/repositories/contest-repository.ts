import type { Language } from "@1brc/domain";
import { and, asc, count, countDistinct, eq, lte, ne } from "drizzle-orm";

import type { LeaderboardRecord } from "../domain/leaderboard.js";
import type { Database } from "../infrastructures/database.js";
import {
  contestState,
  datasetReleases,
  submissions,
  users,
} from "../infrastructures/schema.js";

export type ContestRepository = ReturnType<typeof createContestRepository>;

export function createContestRepository(database: Database) {
  return {
    state() {
      return database
        .result(
          database.orm
            .select()
            .from(contestState)
            .where(eq(contestState.singleton_id, 1)),
        )
        .map((rows) => rows[0] ?? null);
    },
    privatePublished() {
      return database
        .result(
          database.orm
            .select({
              private_published_at: contestState.private_published_at,
            })
            .from(contestState)
            .where(eq(contestState.singleton_id, 1)),
        )
        .map((rows) => Boolean(rows[0]?.private_published_at));
    },
    participationStats() {
      return database
        .result(
          database.orm
            .select({
              participant_count: countDistinct(submissions.username),
              submission_count: count(),
            })
            .from(submissions)
            .where(ne(submissions.status, "rejected")),
        )
        .map((rows) => ({
          participants: rows[0]?.participant_count ?? 0,
          totalSubmissions: rows[0]?.submission_count ?? 0,
        }));
    },
    leaderboard(language: Language | undefined, contestEndAt: Date) {
      return database
        .result(
          database.orm
            .select({
              username: users.username,
              submission_id: submissions.id,
              language: submissions.language,
              public_verdict: submissions.public_verdict,
              public_score_ns: submissions.public_score_ns,
              private_verdict: submissions.private_verdict,
              private_score_ns: submissions.private_score_ns,
              disqualified_reason: submissions.disqualified_reason,
              submitted_at: submissions.upload_started_at,
            })
            .from(users)
            .innerJoin(
              submissions,
              eq(submissions.id, users.representative_submission_id),
            )
            .where(
              and(
                eq(submissions.public_verdict, "accepted"),
                lte(submissions.upload_started_at, contestEndAt),
                language ? eq(submissions.language, language) : undefined,
              ),
            )
            .orderBy(asc(submissions.upload_started_at)),
        )
        .map((rows) =>
          rows.filter(
            (row): row is LeaderboardRecord =>
              row.language !== null && row.public_verdict !== null,
          ),
        );
    },
    leaderboardReplay(contestEndAt: Date) {
      return database
        .result(
          database.orm
            .select({
              submission_id: submissions.id,
              username: submissions.username,
              language: submissions.language,
              public_verdict: submissions.public_verdict,
              private_verdict: submissions.private_verdict,
              private_score_ns: submissions.private_score_ns,
              disqualified_reason: submissions.disqualified_reason,
              submitted_at: submissions.upload_started_at,
            })
            .from(submissions)
            .where(
              and(
                ne(submissions.status, "rejected"),
                lte(submissions.upload_started_at, contestEndAt),
              ),
            )
            .orderBy(asc(submissions.upload_started_at), asc(submissions.id)),
        )
        .map((rows) =>
          rows.map((row) => ({
            submissionId: row.submission_id,
            username: row.username,
            language: row.language,
            publicVerdict: row.public_verdict,
            privateVerdict: row.private_verdict,
            privateScoreNs: row.private_score_ns,
            disqualified: row.disqualified_reason !== null,
            submittedAt: row.submitted_at.toISOString(),
          })),
        );
    },
    publicDatasets(contestId: string) {
      return database.result(
        database.orm
          .select(datasetSelection)
          .from(datasetReleases)
          .where(
            and(
              eq(datasetReleases.contest_id, contestId),
              eq(datasetReleases.is_public, true),
            ),
          )
          .orderBy(datasetReleases.rows_count, datasetReleases.kind),
      );
    },
    publicDataset(contestId: string, artifactId: string) {
      return database
        .result(
          database.orm
            .select(datasetSelection)
            .from(datasetReleases)
            .where(
              and(
                eq(datasetReleases.contest_id, contestId),
                eq(datasetReleases.artifact_id, artifactId),
                eq(datasetReleases.is_public, true),
              ),
            )
            .limit(1),
        )
        .map((rows) => rows[0] ?? null);
    },
  };
}

const datasetSelection = {
  contest_id: datasetReleases.contest_id,
  artifact_id: datasetReleases.artifact_id,
  kind: datasetReleases.kind,
  label: datasetReleases.label,
  object_key: datasetReleases.object_key,
  rows_count: datasetReleases.rows_count,
  compressed_bytes: datasetReleases.compressed_bytes,
  uncompressed_bytes: datasetReleases.uncompressed_bytes,
  compressed_sha256: datasetReleases.compressed_sha256,
  uncompressed_sha256: datasetReleases.uncompressed_sha256,
};
