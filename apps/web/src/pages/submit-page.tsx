import { isSubmissionOpen } from "@1brc/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { SubmissionMethodStep } from "../components/submission/submission-method-step.js";
import {
  NativeBuildStep,
  ProgramStep,
  RuntimeStep,
} from "../components/submission/submission-setup-steps.js";
import { ErrorAlert, PageHeader, Panel } from "../components/ui.js";
import {
  contestGateway,
  contestQueryKeys,
} from "../gateways/contest-gateway.js";
import { submissionGateway } from "../gateways/submission-gateway.js";
import { useClock } from "../gateways/use-clock.js";
import {
  bestAcceptedScore,
  type SubmissionDraft,
} from "../models/submission.js";
import { formatDate } from "../utils/format.js";

import styles from "./submit-page.module.css";

const initialDraft: SubmissionDraft = {
  executionKind: "typescript",
  language: "cpp",
  source: null,
  binary: null,
};

export function SubmitPage() {
  const navigate = useNavigate();
  const now = useClock();
  const [draft, setDraft] = useState<SubmissionDraft>(initialDraft);
  const contest = useQuery({
    queryKey: contestQueryKeys.overview,
    queryFn: contestGateway.contest,
  });
  const submissions = useQuery({
    queryKey: ["submissions"],
    queryFn: submissionGateway.list,
  });
  const submit = useMutation({
    mutationFn: async () => ({
      receipt: await submissionGateway.submit(draft),
      previousBest: bestAcceptedScore(submissions.data?.submissions ?? []),
    }),
    onSuccess: ({ receipt, previousBest }) => {
      const params = new URLSearchParams({ submitted: receipt.id });
      if (previousBest) params.set("previousBest", previousBest);
      void navigate(`/submissions?${params.toString()}`, { replace: true });
    },
  });
  const update = (change: Partial<SubmissionDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const submissionOpen = contest.data
    ? isSubmissionOpen(contest.data, now)
    : false;

  return (
    <div className="page-stack">
      <PageHeader title="提出" />
      {contest.isError ? (
        <ErrorAlert message={contest.error.message} />
      ) : contest.data && !submissionOpen ? (
        <Panel className={styles.availability!}>
          <Clock3 size={22} aria-hidden="true" />
          <div>
            <h2>
              {now < new Date(contest.data.startAt)
                ? "提出受付はまだ始まっていません"
                : "提出受付は終了しました"}
            </h2>
            <p>
              {now < new Date(contest.data.startAt)
                ? `${formatDate(contest.data.startAt)} に開始します。`
                : `${formatDate(contest.data.endAt)} に終了しました。`}
            </p>
          </div>
        </Panel>
      ) : contest.data ? (
        <div className={`panel ${styles.form}`}>
          <ProgramStep />
          <RuntimeStep draft={draft} update={update} />
          <NativeBuildStep draft={draft} />
          <SubmissionMethodStep
            draft={draft}
            update={update}
            isPending={submit.isPending}
            error={submit.error}
            onSubmit={() => submit.mutate()}
          />
        </div>
      ) : null}
    </div>
  );
}
