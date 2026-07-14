import { useEffect, useRef, useState } from "react";

import {
  detectLeaderboardRecordUpdates,
  type LeaderboardRecordUpdate,
} from "../../models/leaderboard-updates.js";
import type { LeaderboardEntry } from "../../models/leaderboard.js";

export type VisibleLeaderboardUpdate = LeaderboardRecordUpdate & {
  sequence: number;
};

export function useLeaderboardUpdates(
  entries: LeaderboardEntry[],
  initialized: boolean,
  visibleForMs = 60_000,
): ReadonlyMap<string, VisibleLeaderboardUpdate> {
  const previousEntries = useRef<LeaderboardEntry[] | null>(null);
  const sequence = useRef(0);
  const timers = useRef(new Map<string, { sequence: number; timer: number }>());
  const [visibleUpdates, setVisibleUpdates] = useState(
    () => new Map<string, VisibleLeaderboardUpdate>(),
  );

  useEffect(() => {
    if (!initialized) return;
    if (previousEntries.current === null) {
      previousEntries.current = entries;
      return;
    }

    const updates = detectLeaderboardRecordUpdates(
      previousEntries.current,
      entries,
    ).map((update) => ({ ...update, sequence: ++sequence.current }));
    previousEntries.current = entries;
    if (updates.length === 0) return;

    setVisibleUpdates((current) => {
      const next = new Map(current);
      for (const update of updates) next.set(update.username, update);
      return next;
    });

    for (const update of updates) {
      const previousTimer = timers.current.get(update.username);
      if (previousTimer) window.clearTimeout(previousTimer.timer);
      const timer = window.setTimeout(() => {
        setVisibleUpdates((current) => {
          if (current.get(update.username)?.sequence !== update.sequence) {
            return current;
          }
          const next = new Map(current);
          next.delete(update.username);
          return next;
        });
        if (timers.current.get(update.username)?.sequence === update.sequence) {
          timers.current.delete(update.username);
        }
      }, visibleForMs);
      timers.current.set(update.username, {
        sequence: update.sequence,
        timer,
      });
    }
  }, [entries, initialized, visibleForMs]);

  useEffect(
    () => () => {
      for (const { timer } of timers.current.values()) {
        window.clearTimeout(timer);
      }
      timers.current.clear();
    },
    [],
  );

  return visibleUpdates;
}
