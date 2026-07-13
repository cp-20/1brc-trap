import * as Dialog from "@radix-ui/react-dialog";
import type { Language } from "@1brc/contracts";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { submissionGateway } from "../gateways/submission-gateway.js";
import type { HighlightLanguage } from "../utils/syntax-highlighter.js";
import { CodeBlock } from "./code-block.js";
import { ErrorAlert } from "./ui.js";
import styles from "./source-dialog.module.css";

const previewLineLimit = 500;

export function SourceDialog({
  submissionId,
  username,
  language,
  onClose,
}: {
  submissionId: string | null;
  username: string;
  language: Language;
  onClose: () => void;
}) {
  const source = useQuery({
    queryKey: ["submission-source", submissionId],
    queryFn: () => submissionGateway.source(submissionId!),
    enabled: submissionId !== null,
  });
  const normalized = source.data?.replace(/\r\n?/g, "\n") ?? "";
  const lines = normalized.split("\n");
  const preview = lines.slice(0, previewLineLimit).join("\n");
  const truncated = lines.length > previewLineLimit;

  return (
    <Dialog.Root
      open={submissionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content}>
          <header className={styles.heading}>
            <div>
              <Dialog.Title>{username} のソースコード</Dialog.Title>
              <Dialog.Description>
                リーダーボードに掲載されている提出
              </Dialog.Description>
            </div>
            <Dialog.Close className={styles.close} aria-label="閉じる">
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className={styles.body}>
            {source.isPending ? (
              <div className={styles.loading}>
                <span className="loading loading-spinner" />
              </div>
            ) : source.isError ? (
              <ErrorAlert message={source.error.message} />
            ) : (
              <>
                <CodeBlock
                  lang={shikiLanguage(language)}
                  className={styles.code!}
                >
                  {preview}
                </CodeBlock>
                {truncated && (
                  <p className={styles.note}>
                    表示を軽くするため、先頭{previewLineLimit}
                    行を表示しています。
                  </p>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function shikiLanguage(language: Language): HighlightLanguage | "text" {
  const languages: Record<Language, HighlightLanguage | "text"> = {
    c: "c",
    cpp: "cpp",
    go: "go",
    rust: "rust",
    zig: "zig",
    csharp: "csharp",
    other: "text",
    javascript: "javascript",
    typescript: "typescript",
    bun: "typescript",
    ruby: "ruby",
  };
  return languages[language];
}
