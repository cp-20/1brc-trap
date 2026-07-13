import { Check } from "lucide-react";
import type { ReactNode } from "react";
import type { SubmissionItem } from "../../gateways/submission-gateway.js";
import styles from "../../pages/submissions-page.module.css";
import { AnimatedDuration, AnimatedNumber } from "../animated-number.js";

export function SubmissionProgress({
  submission,
}: {
  submission: SubmissionItem | undefined;
}) {
  const status = submission?.status ?? "uploading";
  const terminal = [
    "completed",
    "infrastructure_error",
    "disqualified",
    "rejected",
  ].includes(status);
  const currentStep = terminal ? null : status === "running" ? 1 : 0;
  const completedSteps = terminal ? 3 : status === "running" ? 1 : 0;
  const message = resultMessage(submission, status);
  const steps = [
    {
      id: "queue",
      label: (
        <>
          実行キュー待ち
          {status === "queued" && (
            <span className={styles.queueCount}>
              (
              <AnimatedNumber value={submission?.queueAhead ?? 0} suffix="件" />
              )
            </span>
          )}
        </>
      ),
    },
    { id: "measure", label: "実行時間計測" },
    { id: "result", label: "結果を反映" },
  ];

  return (
    <section className={styles.progress} aria-live="polite">
      <div className={styles.progressHeading}>
        <div>
          <span>新しい提出の状況</span>
          <strong>{message}</strong>
        </div>
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={
              index < completedSteps
                ? styles.done
                : currentStep === index
                  ? styles.current
                  : undefined
            }
          >
            <i>
              {index < completedSteps ? (
                <Check size={14} strokeWidth={3} aria-hidden="true" />
              ) : currentStep === index ? (
                <span className="loading loading-spinner" aria-label="処理中" />
              ) : (
                index + 1
              )}
            </i>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      {(submission?.public?.error || submission?.infrastructureError) && (
        <pre className={styles.errorDetail}>
          {submission.public?.error ?? submission.infrastructureError}
        </pre>
      )}
    </section>
  );
}

function resultMessage(
  submission: SubmissionItem | undefined,
  status: string,
): ReactNode {
  if (status === "completed") {
    return submission?.public?.verdict === "accepted" ? (
      <>
        計測が完了しました ·{" "}
        <AnimatedDuration nanoseconds={submission.public.scoreNs} />
      </>
    ) : (
      `計測が完了しました · ${submission?.public ? verdictResult(submission.public.verdict) : "結果なし"}`
    );
  }
  if (status === "running") return "プログラムを計測しています";
  if (status === "infrastructure_error")
    return "計測環境でエラーが発生しました";
  if (status === "uploading") return "提出を受け付けています";
  return "計測の順番を待っています";
}

function verdictResult(verdict: string): string {
  const labels: Record<string, string> = {
    runtime_error: "実行時エラー",
    wrong_answer: "不正解",
    time_limit: "制限時間超過",
    output_limit: "出力制限超過",
  };
  return labels[verdict] ?? verdict;
}
