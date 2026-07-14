import { Copy } from "lucide-react";

import { CodeBlock } from "../code-block.js";

import styles from "../../pages/submit-page.module.css";

export function StepHeading({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.stepHeading}>
      <span>{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

export function FileField({
  label,
  detail,
  accept,
  onChange,
}: {
  label: string;
  detail: string;
  accept?: string;
  onChange: (file: File | null) => void;
}) {
  return (
    <label className={styles.fileField}>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <input
        key={accept}
        className="file-input file-input-bordered w-full"
        type="file"
        accept={accept}
        required
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}

export function CopyableCode({
  value,
  disabled = false,
}: {
  value: string;
  disabled?: boolean;
}) {
  return (
    <div className={styles.copyableCode}>
      <CodeBlock lang="shellscript">{value}</CodeBlock>
      <button
        type="button"
        className="btn btn-square btn-sm"
        aria-label="コマンドをコピー"
        disabled={disabled}
        onClick={() => void navigator.clipboard.writeText(value)}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}
