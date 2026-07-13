import type { LeaderboardEntry } from "./leaderboard.js";

export type LeaderboardRecordUpdate = {
  username: string;
  runtimeDeltaNs: string | null;
};

export function detectLeaderboardRecordUpdates(
  previousEntries: LeaderboardEntry[],
  currentEntries: LeaderboardEntry[],
): LeaderboardRecordUpdate[] {
  const previousByUsername = new Map(
    previousEntries.map((entry) => [entry.username, entry] as const),
  );

  return currentEntries.flatMap((entry) => {
    const previous = previousByUsername.get(entry.username);
    if (!previous) return [{ username: entry.username, runtimeDeltaNs: null }];

    const recordChanged =
      entry.submissionId !== previous.submissionId ||
      entry.scoreNs !== previous.scoreNs ||
      entry.verdict !== previous.verdict;
    if (!recordChanged) return [];

    return [
      {
        username: entry.username,
        runtimeDeltaNs: runtimeDelta(previous.scoreNs, entry.scoreNs),
      },
    ];
  });
}

function runtimeDelta(
  previousScoreNs: string | null,
  currentScoreNs: string | null,
): string | null {
  if (previousScoreNs === null || currentScoreNs === null) return null;
  try {
    return (BigInt(currentScoreNs) - BigInt(previousScoreNs)).toString();
  } catch {
    return null;
  }
}
