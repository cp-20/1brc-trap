import type { Language } from "@1brc/domain";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { LeaderboardTable } from "../components/leaderboard-table.js";
import { Select } from "../components/select.js";
import { ErrorAlert, PageHeader, Panel } from "../components/ui.js";
import {
  contestGateway,
  contestQueryKeys,
} from "../gateways/contest-gateway.js";
import { useClock } from "../gateways/use-clock.js";
import { useContestLive } from "../gateways/use-contest-live.js";
import { hasContestEnded } from "../models/contest.js";
import {
  languageLabel,
  selectableLanguages,
  verdictLabel,
} from "../models/labels.js";
import { buildLeaderboardReplayFrame } from "../models/leaderboard.js";
import { formatDate } from "../utils/format.js";

import styles from "./leaderboard-page.module.css";

export function LeaderboardPage() {
  const now = useClock();
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const [board, setBoard] = useState<LeaderboardBoard>("public");
  const [language, setLanguage] = useState<"all" | Language>("all");
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  useEffect(() => {
    setBoard(contest.data?.privatePublishedAt ? "private" : "public");
  }, [contest.data?.privatePublishedAt]);
  useContestLive(board, language);
  const leaderboard = useQuery({
    queryKey: contestQueryKeys.leaderboard(board, language),
    queryFn: () =>
      contestGateway.leaderboard(
        board,
        language === "all" ? undefined : language,
      ),
  });
  const replayAvailable = Boolean(
    board === "private" &&
    contest.data?.privatePublishedAt &&
    hasContestEnded(contest.data, now),
  );
  const replay = useQuery({
    queryKey: contestQueryKeys.leaderboardReplay,
    queryFn: contestGateway.leaderboardReplay,
    enabled: replayAvailable,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const submissions = replay.data?.submissions ?? [];
  const ranked = leaderboard.data?.ranked ?? [];
  const replayEntries =
    replayIndex !== null && replayIndex < submissions.length
      ? buildLeaderboardReplayFrame(submissions, replayIndex, language)
      : ranked;
  const currentSubmission =
    replayIndex === null ? undefined : submissions[replayIndex - 1];

  useEffect(() => {
    setReplayIndex(null);
    setReplayPlaying(false);
  }, [board, language]);

  useEffect(() => {
    if (!replayPlaying || submissions.length === 0) return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => {
        const next = Math.min(submissions.length, (current ?? 0) + 1);
        if (next === submissions.length) setReplayPlaying(false);
        return next;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [replayPlaying, submissions.length]);

  const toggleReplay = () => {
    if (replayIndex === null || replayIndex >= submissions.length) {
      setReplayIndex(Math.min(1, submissions.length));
      setReplayPlaying(true);
    } else {
      setReplayPlaying((playing) => !playing);
    }
  };

  return (
    <div className="page-stack">
      <PageHeader title="リーダーボード" />
      <div className={styles.toolbar}>
        <div
          className={styles.boardSwitch}
          role="group"
          aria-label="リーダーボードの種類"
        >
          <button
            type="button"
            className={board === "public" ? "selected" : ""}
            onClick={() => setBoard("public")}
          >
            Public
          </button>
          <button
            type="button"
            className={board === "private" ? "selected" : ""}
            disabled={!contest.data?.privatePublishedAt}
            onClick={() => setBoard("private")}
          >
            Private
          </button>
        </div>
        <Select
          ariaLabel="言語で絞り込む"
          compact
          value={language}
          onValueChange={(value) => setLanguage(value as "all" | Language)}
          options={[
            { value: "all", label: "すべての言語" },
            ...selectableLanguages.map((value) => ({
              value,
              label: languageLabel(value),
            })),
          ]}
        />
        {replayAvailable && (
          <div className={styles.replayControls}>
            {replayIndex !== null && submissions.length > 0 && (
              <>
                <input
                  className={styles.replayRange}
                  type="range"
                  min="1"
                  max={submissions.length}
                  value={replayIndex}
                  aria-label="再生位置"
                  onChange={(event) => {
                    setReplayPlaying(false);
                    setReplayIndex(Number(event.currentTarget.value));
                  }}
                />
                <span className={styles.replayCount}>
                  {replayIndex}/{submissions.length}
                </span>
              </>
            )}
            <button
              type="button"
              className={styles.replayButton}
              disabled={replay.isPending || submissions.length === 0}
              onClick={toggleReplay}
            >
              {replayPlaying ? (
                <Pause size={15} />
              ) : replayIndex !== null && replayIndex >= submissions.length ? (
                <RotateCcw size={15} />
              ) : (
                <Play size={15} />
              )}
              {replay.isPending
                ? "履歴を読込中"
                : replayPlaying
                  ? "一時停止"
                  : replayIndex !== null && replayIndex < submissions.length
                    ? "再開"
                    : replayIndex !== null
                      ? "もう一度"
                      : "早送り再生"}
            </button>
          </div>
        )}
      </div>
      {replayIndex !== null && currentSubmission && (
        <div className={styles.replayStatus} aria-live="polite">
          <span>{formatDate(currentSubmission.submittedAt)}</span>
          <strong>{currentSubmission.username}</strong>
          <span>
            {currentSubmission.disqualified
              ? "失格"
              : currentSubmission.publicVerdict
                ? `Public: ${verdictLabel(currentSubmission.publicVerdict)}`
                : "計測エラー"}
          </span>
          {!currentSubmission.disqualified &&
            currentSubmission.privateVerdict && (
              <span>
                Private: {verdictLabel(currentSubmission.privateVerdict)}
              </span>
            )}
        </div>
      )}
      {replayAvailable && replay.isError && (
        <ErrorAlert message={replay.error.message} />
      )}
      {leaderboard.isError ? (
        <ErrorAlert message={leaderboard.error.message} />
      ) : (
        <Panel className="panel-table">
          <LeaderboardTable
            key={`${board}:${language}:ranked`}
            entries={replayEntries}
            initialized={leaderboard.data !== undefined}
            highlightUpdates={replayIndex === null}
          />
        </Panel>
      )}
      {board === "private" &&
        (replayIndex === null || replayIndex >= submissions.length) &&
        (leaderboard.data?.disqualified.length ?? 0) > 0 && (
          <Panel className="panel-table">
            <div className="panel-heading">
              <div>
                <h2>失格</h2>
                <p>Private計測で正解しなかった提出</p>
              </div>
            </div>
            <LeaderboardTable
              key={`${board}:${language}:disqualified`}
              entries={leaderboard.data?.disqualified ?? []}
              initialized={leaderboard.data !== undefined}
            />
          </Panel>
        )}
    </div>
  );
}
import type { LeaderboardBoard } from "@1brc/domain";
