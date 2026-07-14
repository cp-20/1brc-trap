import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ArrowDown, ArrowUp, Code2 } from "lucide-react";
import { useState } from "react";

import { avatarUrl } from "../models/identity.js";
import { languageLabel } from "../models/labels.js";
import type { LeaderboardEntry } from "../models/leaderboard.js";
import { formatDate } from "../utils/format.js";
import {
  AnimatedDuration,
  AnimatedDurationDelta,
  AnimatedNumber,
} from "./animated-number.js";
import { useLeaderboardUpdates } from "./leaderboard/use-leaderboard-updates.js";
import { SourceDialog } from "./source-dialog.js";
import { Empty, VerdictBadge } from "./ui.js";

import styles from "./leaderboard-table.module.css";

export function LeaderboardTable({
  entries,
  comparisonEntries = entries,
  initialized,
  compact = false,
}: {
  entries: LeaderboardEntry[];
  comparisonEntries?: LeaderboardEntry[];
  initialized: boolean;
  compact?: boolean;
}) {
  const [sourceEntry, setSourceEntry] = useState<LeaderboardEntry | null>(null);
  const updates = useLeaderboardUpdates(comparisonEntries, initialized);
  const [animationParent] = useAutoAnimate<HTMLTableSectionElement>({
    duration: 520,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });

  return (
    <>
      <div
        className={`${styles.viewport} ${compact ? styles.compactViewport : ""}`}
        aria-busy={!initialized}
      >
        <table
          className={`ranking-table ${compact ? "ranking-table-compact" : ""}`}
        >
          <thead>
            <tr>
              <th className={styles.rankColumn}>順位</th>
              <th className={styles.userColumn}>ユーザー</th>
              <th className={styles.languageColumn}>言語</th>
              <th className={styles.scoreColumn}>実行時間</th>
              {!compact && <th className={styles.dateColumn}>提出日時</th>}
              <th className={styles.sourceColumn} aria-label="ソースコード" />
            </tr>
          </thead>
          <tbody ref={entries.length > 0 ? animationParent : undefined}>
            {!initialized &&
              Array.from({ length: compact ? 5 : 8 }, (_, index) => (
                <tr key={index} className={styles.skeletonRow} aria-hidden>
                  <td className={styles.rankColumn}>
                    <span className="skeleton-block" />
                  </td>
                  <td className={styles.userColumn}>
                    <div>
                      <span className="skeleton-block" />
                      <span className="skeleton-block" />
                    </div>
                  </td>
                  <td className={styles.languageColumn}>
                    <span className="skeleton-block" />
                  </td>
                  <td className={styles.scoreColumn}>
                    <span className="skeleton-block" />
                  </td>
                  {!compact && (
                    <td className={styles.dateColumn}>
                      <span className="skeleton-block" />
                    </td>
                  )}
                  <td className={styles.sourceColumn} />
                </tr>
              ))}
            {entries.map((entry) => {
              const update = updates.get(entry.username);
              return (
                <tr
                  key={entry.username}
                  className={
                    update
                      ? update.sequence % 2 === 0
                        ? styles.updatedRowA
                        : styles.updatedRowB
                      : undefined
                  }
                >
                  <td className={`ranking-rank ${styles.rankColumn}`}>
                    <div className="ranking-rank-value">
                      <strong>
                        {entry.rank === null ? (
                          "—"
                        ) : (
                          <AnimatedNumber value={entry.rank} />
                        )}
                      </strong>
                      {entry.rankChange !== null && (
                        <span
                          className={
                            entry.rankChange > 0
                              ? "rank-change rank-up"
                              : entry.rankChange < 0
                                ? "rank-change rank-down"
                                : "rank-change"
                          }
                          title={rankChangeLabel(entry.rankChange)}
                        >
                          {entry.rankChange > 0 ? (
                            <ArrowUp size={11} />
                          ) : entry.rankChange < 0 ? (
                            <ArrowDown size={11} />
                          ) : null}
                          {entry.rankChange === 0 && "±"}
                          <AnimatedNumber value={Math.abs(entry.rankChange)} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={styles.userColumn}>
                    <div className="user-cell">
                      <img
                        src={avatarUrl(entry.username, 48)}
                        alt=""
                        width={24}
                        height={24}
                        loading="lazy"
                      />
                      <span>{entry.username}</span>
                    </div>
                  </td>
                  <td className={styles.languageColumn}>
                    <span className="language-chip">
                      {languageLabel(entry.language)}
                    </span>
                  </td>
                  <td
                    className={`mono-number ranking-score ${styles.scoreColumn}`}
                  >
                    {entry.verdict === "accepted" ? (
                      <div className={styles.runtimeValue}>
                        <AnimatedDuration nanoseconds={entry.scoreNs} />
                        <span className={styles.runtimeDiffSlot}>
                          {update?.runtimeDeltaNs !== null &&
                            update?.runtimeDeltaNs !== undefined && (
                              <AnimatedDurationDelta
                                key={update.sequence}
                                nanoseconds={update.runtimeDeltaNs}
                                className={`${styles.runtimeDiff} ${runtimeDiffClass(update.runtimeDeltaNs)}`}
                              />
                            )}
                        </span>
                      </div>
                    ) : (
                      <VerdictBadge verdict={entry.verdict} />
                    )}
                  </td>
                  {!compact && (
                    <td className={`muted-cell ${styles.dateColumn}`}>
                      {formatDate(entry.submittedAt)}
                    </td>
                  )}
                  <td className={styles.sourceColumn}>
                    {entry.sourceAvailable && (
                      <button
                        type="button"
                        className="icon-link"
                        onClick={() => setSourceEntry(entry)}
                        aria-label={`${entry.username} のソースコードを表示`}
                        title="ソースコードを表示"
                      >
                        <Code2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {initialized && entries.length === 0 && (
          <Empty text="表示できる記録がありません" />
        )}
      </div>
      <SourceDialog
        submissionId={sourceEntry?.submissionId ?? null}
        username={sourceEntry?.username ?? ""}
        language={sourceEntry?.language ?? "other"}
        onClose={() => setSourceEntry(null)}
      />
    </>
  );
}

function runtimeDiffClass(deltaNs: string): string {
  const delta = BigInt(deltaNs);
  if (delta < 0n) return styles.runtimeFaster!;
  if (delta > 0n) return styles.runtimeSlower!;
  return styles.runtimeUnchanged!;
}

function rankChangeLabel(change: number): string {
  if (change > 0) return `Public順位から${change}位上昇`;
  if (change < 0) return `Public順位から${Math.abs(change)}位下降`;
  return "Public順位から変動なし";
}
