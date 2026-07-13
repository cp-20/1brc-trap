import { useMutation } from "@tanstack/react-query";
import { Copy, KeyRound, Send, Terminal, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { SourcePreview } from "../source-preview.js";
import { CodeBlock } from "../code-block.js";
import { ErrorAlert } from "../ui.js";
import { accountGateway } from "../../gateways/account-gateway.js";
import type { SubmissionDraft } from "../../models/submission.js";
import {
  createCurlExample,
  previewLanguage,
  sourceAccept,
} from "../../models/submission-options.js";
import styles from "../../pages/submit-page.module.css";
import { CopyableCode, FileField, StepHeading } from "./submit-step.js";

type SubmitMethod = "browser" | "cli";

export function SubmissionMethodStep({
  draft,
  update,
  isPending,
  error,
  onSubmit,
}: {
  draft: SubmissionDraft;
  update: (change: Partial<SubmissionDraft>) => void;
  isPending: boolean;
  error: Error | null;
  onSubmit: () => void;
}) {
  const [method, setMethod] = useState<SubmitMethod>("browser");
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const issueKey = useMutation({
    mutationFn: accountGateway.issueAccessKey,
    onSuccess: ({ accessKey: issued }) => setAccessKey(issued),
  });
  const curlExample = useMemo(() => createCurlExample(draft), [draft]);
  const acceptedSource = sourceAccept(draft);
  const canSubmit =
    draft.source !== null &&
    (draft.executionKind !== "native" || draft.binary !== null);
  const stepNumber = draft.executionKind === "native" ? 4 : 3;

  return (
    <section className={styles.step}>
      <StepHeading
        number={stepNumber}
        title="提出する"
        description="ブラウザまたはコマンドラインから提出します。提出後は履歴で計測状況を確認できます。"
      />
      <div className={styles.stepContent}>
        <div className={styles.methodTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={method === "browser"}
            className={method === "browser" ? styles.selected : undefined}
            onClick={() => setMethod("browser")}
          >
            <Upload size={16} /> ファイルを選ぶ
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={method === "cli"}
            className={method === "cli" ? styles.selected : undefined}
            onClick={() => setMethod("cli")}
          >
            <Terminal size={16} /> コマンドライン
          </button>
        </div>

        {method === "browser" ? (
          <form
            className={styles.browserSubmit}
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <FileField
              label="ソースコード"
              detail="UTF-8・1 MiB以下"
              {...(acceptedSource ? { accept: acceptedSource } : {})}
              onChange={(source) => update({ source })}
            />
            {draft.executionKind === "native" && (
              <FileField
                label="実行ファイル"
                detail="Linux x86_64 ELF・64 MiB以下"
                onChange={(binary) => update({ binary })}
              />
            )}
            {error && <ErrorAlert message={error.message} />}
            <button
              className={`btn btn-primary ${styles.submitButton}`}
              disabled={isPending || !canSubmit}
            >
              {isPending ? (
                <span className="loading loading-spinner" />
              ) : (
                <Send size={17} />
              )}
              提出する
            </button>
            {draft.source && (
              <SourcePreview
                file={draft.source}
                language={previewLanguage(draft)}
              />
            )}
          </form>
        ) : (
          <div className={styles.cliSubmit}>
            <div className={styles.cliHeading}>
              <div>
                <h3>1. アクセスキーを準備する</h3>
                <p>
                  発行すると以前のキーは使えなくなります。新しいキーはこの画面で一度だけ表示します。
                </p>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={issueKey.isPending}
                onClick={() => issueKey.mutate()}
              >
                <KeyRound size={16} />
                {accessKey ? "再発行" : "アクセスキーを発行"}
              </button>
            </div>
            {issueKey.error && <ErrorAlert message={issueKey.error.message} />}
            <CopyableCode
              value={
                accessKey
                  ? `export ONEBRC_ACCESS_KEY='${accessKey}'`
                  : "export ONEBRC_ACCESS_KEY='<発行したアクセスキー>'"
              }
              disabled={!accessKey}
            />

            <div className={styles.cliHeading}>
              <div>
                <h3>2. 提出コマンドを実行する</h3>
                <p>
                  ソースコードと同じディレクトリで実行します。ファイル名は必要に応じて書き換えてください。
                </p>
              </div>
              <button
                type="button"
                className="btn btn-square btn-sm"
                aria-label="curlコマンドをコピー"
                onClick={() => void navigator.clipboard.writeText(curlExample)}
              >
                <Copy size={15} />
              </button>
            </div>
            <CodeBlock lang="shellscript">{curlExample}</CodeBlock>
          </div>
        )}
      </div>
    </section>
  );
}
