import { describe, expect, it } from "vitest";

import { detectLeaderboardRecordUpdates } from "./leaderboard-updates.js";
import type { LeaderboardEntry } from "./leaderboard.js";

describe("detectLeaderboardRecordUpdates", () => {
  it("本人の代表提出が変わった場合だけ実行時間差分を返す", () => {
    const previous = [entry("mina", 1, "old", "160000000")];
    const current = [
      entry("mina", 1, "new", "150000000"),
      entry("Pugma", 2, "same", "180000000"),
    ];

    expect(detectLeaderboardRecordUpdates(previous, current)).toEqual([
      { username: "mina", runtimeDeltaNs: "-10000000" },
      { username: "Pugma", runtimeDeltaNs: null },
    ]);
  });

  it("他ユーザーの更新に伴う順位変動は更新扱いにしない", () => {
    const previous = [entry("mina", 1, "same", "150000000")];
    const current = [entry("mina", 2, "same", "150000000")];

    expect(detectLeaderboardRecordUpdates(previous, current)).toEqual([]);
  });

  it("表示圏外から最終行へ入った本人の更新と差分を検出する", () => {
    const previous = Array.from({ length: 9 }, (_, index) =>
      entry(
        `user-${index + 1}`,
        index + 1,
        `old-${index + 1}`,
        `${index + 1}000`,
      ),
    );
    const incoming = entry("user-9", 8, "new-9", "7999");
    const current = [
      ...previous.slice(0, 7),
      incoming,
      { ...previous[7]!, rank: 9 },
    ];

    expect(detectLeaderboardRecordUpdates(previous, current)).toEqual([
      { username: "user-9", runtimeDeltaNs: "-1001" },
    ]);
  });
});

function entry(
  username: string,
  rank: number,
  submissionId: string,
  scoreNs: string,
): LeaderboardEntry {
  return {
    rank,
    rankChange: null,
    username,
    submissionId,
    language: "typescript",
    scoreNs,
    verdict: "accepted",
    submittedAt: "2026-01-01T00:00:00.000Z",
    sourceAvailable: false,
  };
}
