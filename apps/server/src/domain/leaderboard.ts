import type { LeaderboardEntry } from "@1brc/domain";
import type { submissions, users } from "../infrastructures/schema.js";

type Submission = typeof submissions.$inferSelect;
export type LeaderboardRecord = {
  username: typeof users.$inferSelect.username;
  submission_id: Submission["id"];
  language: NonNullable<Submission["language"]>;
  public_verdict: NonNullable<Submission["public_verdict"]>;
  public_score_ns: Submission["public_score_ns"];
  private_verdict: Submission["private_verdict"];
  private_score_ns: Submission["private_score_ns"];
  disqualified_reason: Submission["disqualified_reason"];
  submitted_at: Submission["upload_started_at"];
};

export function buildLeaderboard(
  rows: LeaderboardRecord[],
  board: "public" | "private",
  privatePublished: boolean,
) {
  const publicRanks = calculateRanks(rows, "public");
  const privateRanks = calculateRanks(rows, "private");
  const entries = rows.map((row): LeaderboardEntry => {
    const verdict = row.disqualified_reason
      ? "disqualified"
      : board === "private"
        ? (row.private_verdict ?? "infrastructure_error")
        : row.public_verdict;
    const publicRank = publicRanks.get(row.submission_id) ?? null;
    const privateRank = privateRanks.get(row.submission_id) ?? null;
    return {
      rank: board === "private" ? privateRank : publicRank,
      rankChange:
        privatePublished && publicRank !== null && privateRank !== null
          ? publicRank - privateRank
          : null,
      username: row.username,
      submissionId: row.submission_id,
      language: row.language,
      scoreNs: board === "private" ? row.private_score_ns : row.public_score_ns,
      verdict,
      submittedAt: row.submitted_at.toISOString(),
      sourceAvailable: privatePublished,
    };
  });
  const ranked = entries
    .filter((entry) => entry.rank !== null)
    .sort((left, right) => left.rank! - right.rank!);
  const disqualified = entries.filter((entry) => entry.rank === null);
  return { board, privatePublished, ranked, disqualified };
}

function calculateRanks(
  rows: LeaderboardRecord[],
  board: "public" | "private",
): Map<string, number> {
  const accepted = rows
    .filter((row) => {
      if (row.disqualified_reason) return false;
      if (board === "public") {
        return (
          row.public_verdict === "accepted" && row.public_score_ns !== null
        );
      }
      return (
        row.private_verdict === "accepted" && row.private_score_ns !== null
      );
    })
    .sort((left, right) => {
      const leftScore = BigInt(
        board === "public" ? left.public_score_ns! : left.private_score_ns!,
      );
      const rightScore = BigInt(
        board === "public" ? right.public_score_ns! : right.private_score_ns!,
      );
      if (leftScore !== rightScore) return leftScore < rightScore ? -1 : 1;
      return left.submitted_at.getTime() - right.submitted_at.getTime();
    });
  return new Map(
    accepted.map((row, index) => [row.submission_id, index + 1] as const),
  );
}
