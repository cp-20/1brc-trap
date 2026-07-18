import { describe, expect, it } from "bun:test";

import { buildLeaderboard, type LeaderboardRecord } from "./leaderboard.js";

const rows: LeaderboardRecord[] = [
  record("A", "100", "300"),
  record("B", "200", "100"),
  record("C", "300", "200"),
];

describe("buildLeaderboard", () => {
  it("Public順位からPrivate順位への変動を計算する", () => {
    const board = buildLeaderboard(rows, "private", true);
    expect(
      board.ranked.map(({ username, rank, rankChange }) => ({
        username,
        rank,
        rankChange,
      })),
    ).toEqual([
      { username: "B", rank: 1, rankChange: 1 },
      { username: "C", rank: 2, rankChange: 1 },
      { username: "A", rank: 3, rankChange: -2 },
    ]);
  });

  it("Private結果の非公開中は順位変動とソースを公開しない", () => {
    const board = buildLeaderboard(rows, "public", false);
    expect(board.ranked.every((entry) => entry.rankChange === null)).toBe(true);
    expect(board.ranked.every((entry) => !entry.sourceAvailable)).toBe(true);
  });
});

function record(
  username: string,
  publicScore: string,
  privateScore: string,
): LeaderboardRecord {
  return {
    username,
    submission_id: username,
    language: "c",
    public_verdict: "accepted",
    public_score_ns: publicScore,
    private_verdict: "accepted",
    private_score_ns: privateScore,
    disqualified_reason: null,
    submitted_at: new Date("2026-01-01T00:00:00Z"),
  };
}
