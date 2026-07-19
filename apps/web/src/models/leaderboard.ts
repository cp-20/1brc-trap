import {
  compareNanoseconds,
  type Language,
  type LeaderboardEntry,
  type LeaderboardReplaySubmission,
} from "@1brc/domain";

export type { LeaderboardEntry } from "@1brc/domain";

export function buildLeaderboardReplayFrame(
  submissions: LeaderboardReplaySubmission[],
  submissionCount: number,
  language: "all" | Language = "all",
): LeaderboardEntry[] {
  const representatives = new Map<string, LeaderboardReplaySubmission>();
  for (const submission of submissions.slice(0, submissionCount)) {
    if (submission.publicVerdict === "accepted") {
      representatives.set(submission.username, submission);
    }
  }

  return [...representatives.values()]
    .filter(
      (submission) =>
        !submission.disqualified &&
        submission.language !== null &&
        (language === "all" || submission.language === language) &&
        submission.privateVerdict === "accepted" &&
        submission.privateScoreNs !== null,
    )
    .sort((left, right) => {
      const scoreOrder = compareNanoseconds(
        left.privateScoreNs!,
        right.privateScoreNs!,
      );
      if (scoreOrder !== 0) return scoreOrder;
      return (
        new Date(left.submittedAt).getTime() -
        new Date(right.submittedAt).getTime()
      );
    })
    .map((submission, index) => ({
      rank: index + 1,
      rankChange: null,
      username: submission.username,
      submissionId: submission.submissionId,
      language: submission.language!,
      scoreNs: submission.privateScoreNs,
      verdict: "accepted",
      submittedAt: submission.submittedAt,
      sourceAvailable: false,
    }));
}
