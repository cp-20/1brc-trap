import { useQuery } from "@tanstack/react-query";
import type { Language } from "@1brc/domain";
import { useEffect, useState } from "react";
import { LeaderboardTable } from "../components/leaderboard-table.js";
import { Select } from "../components/select.js";
import { ErrorAlert, PageHeader, Panel } from "../components/ui.js";
import {
  contestGateway,
  contestQueryKeys,
} from "../gateways/contest-gateway.js";
import { useContestLive } from "../gateways/use-contest-live.js";
import { selectableLanguages, languageLabel } from "../models/labels.js";
import styles from "./leaderboard-page.module.css";

export function LeaderboardPage() {
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const [board, setBoard] = useState<"public" | "private">("public");
  const [language, setLanguage] = useState<"all" | Language>("all");
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
      </div>
      {leaderboard.isError ? (
        <ErrorAlert message={leaderboard.error.message} />
      ) : (
        <Panel className="panel-table">
          <LeaderboardTable
            key={`${board}:${language}:ranked`}
            entries={leaderboard.data?.ranked ?? []}
            initialized={leaderboard.data !== undefined}
          />
        </Panel>
      )}
      {board === "private" &&
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
