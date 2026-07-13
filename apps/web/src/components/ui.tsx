import type { Verdict } from "@1brc/contracts";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { verdictLabel } from "../models/labels.js";
export { CodeBlock } from "./code-block.js";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function Loading() {
  return (
    <div className="grid min-h-72 place-items-center">
      <span className="loading loading-spinner loading-lg text-primary" />
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

export function ErrorAlert({
  message = "エラーが発生しました",
}: {
  message?: string | undefined;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  );
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice notice-success">
      <CheckCircle2 size={18} />
      <span>{children}</span>
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const tone =
    value === "completed"
      ? "positive"
      : value === "running"
        ? "info"
        : value === "queued" || value === "uploading"
          ? "warning"
          : value.includes("error") ||
              value === "rejected" ||
              value === "disqualified"
            ? "negative"
            : "muted";
  const label: Record<string, string> = {
    uploading: "アップロード中",
    queued: "待機中",
    running: "計測中",
    completed: "完了",
    rejected: "却下",
    infrastructure_error: "計測エラー",
    disqualified: "失格",
  };
  return (
    <span className={`status-badge status-${tone}`}>
      {label[value] ?? value}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const tone =
    verdict === "accepted"
      ? "positive"
      : verdict === "infrastructure_error"
        ? "warning"
        : "negative";
  return (
    <span className={`status-badge status-${tone}`}>
      {verdictLabel(verdict)}
    </span>
  );
}
