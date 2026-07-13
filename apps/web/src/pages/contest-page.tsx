import { useQuery } from "@tanstack/react-query";
import { Clock3, Send } from "lucide-react";
import { Link } from "react-router-dom";
import { ContestDocument } from "../components/contest/contest-document.js";
import { ErrorAlert, PageHeader, Panel } from "../components/ui.js";
import {
  contestGateway,
  contestQueryKeys,
} from "../gateways/contest-gateway.js";
import { useClock } from "../gateways/use-clock.js";
import { hasContestStarted, isSubmissionOpen } from "../models/contest.js";
import { formatDate } from "../utils/format.js";
import styles from "./contest-page.module.css";

export function ContestPage() {
  const now = useClock();
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const started = contest.data ? hasContestStarted(contest.data, now) : false;
  const submissionOpen = contest.data
    ? isSubmissionOpen(contest.data, now)
    : false;
  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: contestGateway.datasets,
    enabled: started,
  });
  return (
    <div className="page-stack">
      <PageHeader
        title="コンテスト"
        action={
          submissionOpen && (
            <Link
              className={`btn btn-primary btn-sm ${styles.submitButton}`}
              to="/submit"
            >
              <Send size={16} /> 提出する
            </Link>
          )
        }
      />
      {contest.data && started ? (
        <ContestDocument
          environment={contest.data.environment}
          datasets={datasets.data}
          datasetsError={datasets.isError}
        />
      ) : contest.data ? (
        <Panel className={styles.locked!}>
          <Clock3 size={22} aria-hidden="true" />
          <div>
            <h2>ルールはコンテスト開始時に公開します</h2>
            <p>{formatDate(contest.data.startAt)} に開始します。</p>
          </div>
        </Panel>
      ) : contest.isError ? (
        <ErrorAlert message={contest.error.message} />
      ) : (
        <Panel
          className={styles.stateSkeleton!}
          aria-label="コンテストを読み込み中"
        >
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </Panel>
      )}
    </div>
  );
}
