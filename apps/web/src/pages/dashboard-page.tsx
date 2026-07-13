import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ListChecks, Send, Timer, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AnimatedCountdown,
  AnimatedNumber,
} from "../components/animated-number.js";
import { LeaderboardTable } from "../components/leaderboard-table.js";
import { ErrorAlert, Loading, Panel } from "../components/ui.js";
import {
  contestGateway,
  contestQueryKeys,
} from "../gateways/contest-gateway.js";
import { useContestLive } from "../gateways/use-contest-live.js";
import { getContestPhase } from "../models/contest.js";
import { formatDate } from "../utils/format.js";
import styles from "./dashboard-page.module.css";

export function DashboardPage() {
  const [now, setNow] = useState(() => new Date());
  useContestLive("public");
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const leaderboard = useQuery({
    queryKey: contestQueryKeys.leaderboard("public"),
    queryFn: () => contestGateway.leaderboard("public"),
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (contest.isPending) return <Loading />;
  if (!contest.data) return <ErrorAlert message={contest.error?.message} />;
  const phase = getContestPhase(contest.data, now);
  const startsAt = new Date(contest.data.startAt).getTime();
  const endsAt = new Date(contest.data.endAt).getTime();
  const elapsedRatio = Math.max(
    0,
    Math.min(1, (now.getTime() - startsAt) / (endsAt - startsAt)),
  );
  return (
    <div className="page-stack">
      <section className={styles.hero}>
        <p className={styles.eyebrow}>OPTIMIZATION CONTEST</p>
        <h1>{contest.data.name}</h1>
        <p>traQ風CSVを集計するプログラムの実行時間を競うコンテストです。</p>
        <div className={styles.actions}>
          <Link className="btn btn-primary" to="/submit">
            <Send size={17} /> 提出する
          </Link>
          <Link className="text-link" to="/contest">
            ルールを見る <ArrowRight size={15} />
          </Link>
        </div>
      </section>
      <div className={styles.meta}>
        <div className={styles.metaCard}>
          <Timer size={17} aria-hidden="true" />
          <div className={styles.metaCopy}>
            <span>{phase.label}</span>
            <strong className={styles.countdown}>
              <AnimatedCountdown
                milliseconds={phase.target.getTime() - now.getTime()}
              />
            </strong>
            <small>{formatDate(contest.data.endAt)} に終了</small>
          </div>
          <div
            className={styles.progressRing}
            style={{
              background: `conic-gradient(#20beff ${elapsedRatio * 360}deg, #303b48 0deg)`,
            }}
            aria-label={`コンテスト期間の${Math.round(elapsedRatio * 100)}%が経過`}
          ></div>
        </div>
        <div className={styles.metaCard}>
          <Users size={17} />
          <div className={styles.metaCopy}>
            <span>参加者</span>
            <strong>
              <AnimatedNumber value={contest.data.participants} suffix=" 人" />
            </strong>
          </div>
        </div>
        <div className={styles.metaCard}>
          <ListChecks size={17} />
          <div className={styles.metaCopy}>
            <span>総提出数</span>
            <strong>
              <AnimatedNumber
                value={contest.data.totalSubmissions}
                suffix=" 件"
              />
            </strong>
          </div>
        </div>
      </div>
      <Panel className="panel-table">
        <div className="panel-heading">
          <div>
            <h2>リーダーボード</h2>
          </div>
          <Link className="text-link" to="/leaderboard">
            すべて見る <ArrowRight size={15} />
          </Link>
        </div>
        <LeaderboardTable
          entries={leaderboard.data?.ranked.slice(0, 8) ?? []}
          comparisonEntries={leaderboard.data?.ranked ?? []}
          initialized={leaderboard.data !== undefined}
          compact
        />
      </Panel>
    </div>
  );
}
