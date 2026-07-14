import { isSubmissionActive } from "@1brc/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Confetti } from "../components/confetti.js";
import { SubmissionHistoryTable } from "../components/submission/submission-history-table.js";
import { SubmissionProgress } from "../components/submission/submission-progress.js";
import { ErrorAlert, PageHeader } from "../components/ui.js";
import { contestGateway } from "../gateways/contest-gateway.js";
import { submissionGateway } from "../gateways/submission-gateway.js";
import { isBetterScore } from "../models/submission.js";

import styles from "./submissions-page.module.css";

export function SubmissionsPage() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const submittedId = params.get("submitted");
  const previousBest = params.get("previousBest");
  const celebrated = useRef<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const contest = useQuery({
    queryKey: ["contest"],
    queryFn: contestGateway.contest,
    refetchInterval: 30_000,
  });
  const submissions = useQuery({
    queryKey: ["submissions"],
    queryFn: submissionGateway.list,
  });
  const submitted = submittedId
    ? submissions.data?.submissions.find((item) => item.id === submittedId)
    : undefined;
  const latestSubmission = submissions.data?.submissions[0];
  const processingSubmission =
    latestSubmission && isSubmissionActive(latestSubmission.status)
      ? latestSubmission
      : undefined;
  const submittedLoaded = submitted !== undefined;

  useLayoutEffect(() => {
    if (!submittedId) return;
    const scrollToTop = () => window.scrollTo(0, 0);
    scrollToTop();
    let settledFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      scrollToTop();
      settledFrame = window.requestAnimationFrame(scrollToTop);
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      window.cancelAnimationFrame(settledFrame);
    };
  }, [submittedId, submittedLoaded]);

  useEffect(
    () =>
      submissionGateway.subscribe((data) => {
        queryClient.setQueryData(["submissions"], data);
      }),
    [queryClient],
  );

  useEffect(() => {
    if (!submittedId || celebrated.current === submittedId) return;
    const completedSubmission = submissions.data?.submissions.find(
      (item) => item.id === submittedId,
    );
    if (
      completedSubmission?.status === "completed" &&
      completedSubmission.public?.verdict === "accepted" &&
      isBetterScore(completedSubmission.public.scoreNs, previousBest)
    ) {
      celebrated.current = submittedId;
      setShowConfetti(true);
    }
  }, [previousBest, submittedId, submissions.data]);

  return (
    <div className={`page-stack ${styles.page}`}>
      {showConfetti && <Confetti onDone={() => setShowConfetti(false)} />}
      <PageHeader
        title="提出履歴"
        action={
          <Link className="btn btn-primary btn-sm" to="/submit">
            <Send size={16} /> 新しく提出
          </Link>
        }
      />
      {processingSubmission && (
        <SubmissionProgress submission={processingSubmission} />
      )}
      {submissions.isError ? (
        <ErrorAlert message={submissions.error.message} />
      ) : (
        <SubmissionHistoryTable
          submissions={submissions.data?.submissions ?? []}
          submittedId={submittedId}
          privatePublished={Boolean(contest.data?.privatePublishedAt)}
        />
      )}
    </div>
  );
}
