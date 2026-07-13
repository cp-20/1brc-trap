import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  NativeBuildStep,
  ProgramStep,
  RuntimeStep,
} from "../components/submission/submission-setup-steps.js";
import { SubmissionMethodStep } from "../components/submission/submission-method-step.js";
import { PageHeader } from "../components/ui.js";
import { submissionGateway } from "../gateways/submission-gateway.js";
import {
  bestAcceptedScore,
  type SubmissionDraft,
} from "../models/submission.js";
import styles from "./submit-page.module.css";

const initialDraft: SubmissionDraft = {
  executionKind: "typescript",
  language: "cpp",
  source: null,
  binary: null,
};

export function SubmitPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<SubmissionDraft>(initialDraft);
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
      navigate(`/submissions?${params.toString()}`, { replace: true });
    },
  });
  const update = (change: Partial<SubmissionDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  return (
    <div className="page-stack">
      <PageHeader title="提出" />
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
    </div>
  );
}
