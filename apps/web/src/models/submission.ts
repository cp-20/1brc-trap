import {
  compareNanoseconds,
  type ExecutionKind,
  type Language,
} from "@1brc/domain";

export type SubmissionDraft = {
  executionKind: ExecutionKind;
  language: Language;
  source: File | null;
  binary: File | null;
};

export function bestAcceptedScore(
  submissions: readonly {
    public: { verdict: string; scoreNs: string | null } | null;
  }[],
): string | null {
  const scores = submissions.flatMap((submission) =>
    submission.public?.verdict === "accepted" && submission.public.scoreNs
      ? [submission.public.scoreNs]
      : [],
  );
  if (scores.length === 0) return null;
  return scores.reduce((best, score) =>
    compareNanoseconds(score, best) < 0 ? score : best,
  );
}

export function isBetterScore(
  score: string | null,
  previousBest: string | null,
): boolean {
  return Boolean(
    score && (!previousBest || compareNanoseconds(score, previousBest) < 0),
  );
}
