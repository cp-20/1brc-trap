import { describe, expect, it } from "bun:test";

import type { LeaderboardReplaySubmission } from "@1brc/domain";

import { buildLeaderboardReplayFrame } from "./leaderboard.js";

describe("buildLeaderboardReplayFrame", () => {
  it("各時点の最新Public正解提出を代表としてPrivate順位を再現する", () => {
    const submissions = [
      submission("a-1", "a", "300", "2026-01-01T00:00:00Z"),
      submission("b-1", "b", "200", "2026-01-01T00:01:00Z"),
      submission("a-failed", "a", null, "2026-01-01T00:02:00Z"),
      submission("a-2", "a", "100", "2026-01-01T00:03:00Z"),
    ];

    expect(
      buildLeaderboardReplayFrame(submissions, 3).map(
        ({ username, rank, submissionId }) => ({
          username,
          rank,
          submissionId,
        }),
      ),
    ).toEqual([
      { username: "b", rank: 1, submissionId: "b-1" },
      { username: "a", rank: 2, submissionId: "a-1" },
    ]);
    expect(
      buildLeaderboardReplayFrame(submissions, 4).map(
        ({ username, rank, submissionId }) => ({
          username,
          rank,
          submissionId,
        }),
      ),
    ).toEqual([
      { username: "a", rank: 1, submissionId: "a-2" },
      { username: "b", rank: 2, submissionId: "b-1" },
    ]);
  });
});

function submission(
  submissionId: string,
  username: string,
  privateScoreNs: string | null,
  submittedAt: string,
): LeaderboardReplaySubmission {
  return {
    submissionId,
    username,
    language: "cpp",
    publicVerdict: privateScoreNs === null ? "wrong_answer" : "accepted",
    privateVerdict: privateScoreNs === null ? null : "accepted",
    privateScoreNs,
    disqualified: false,
    submittedAt,
  };
}
