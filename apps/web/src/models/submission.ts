import type { Language } from "@1brc/contracts";

export type SubmissionDraft = {
  executionKind: "typescript" | "javascript" | "bun" | "ruby" | "native";
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
    BigInt(score) < BigInt(best) ? score : best,
  );
}

export function isBetterScore(
  score: string | null,
  previousBest: string | null,
): boolean {
  return Boolean(
    score && (!previousBest || BigInt(score) < BigInt(previousBest)),
  );
}

export function isProcessing(submission: { status: string }): boolean {
  return ["uploading", "queued", "running"].includes(submission.status);
}
