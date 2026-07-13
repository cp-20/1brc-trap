import { useEffect, useState } from "react";
import { formatBytes } from "../utils/format.js";
import type { HighlightLanguage } from "../utils/syntax-highlighter.js";
import { CodeBlock } from "./code-block.js";
import styles from "./source-preview.module.css";

const previewLineLimit = 240;

export function SourcePreview({
  file,
  language,
}: {
  file: File;
  language: HighlightLanguage | "text";
}) {
  const [source, setSource] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let active = true;
    setSource("");
    setTruncated(false);
    void file.text().then((content) => {
      if (!active) return;
      const lines = content.replace(/\r\n?/g, "\n").split("\n");
      setSource(lines.slice(0, previewLineLimit).join("\n"));
      setTruncated(lines.length > previewLineLimit);
    });
    return () => {
      active = false;
    };
  }, [file]);

  return (
    <div className={styles.preview}>
      <div className={styles.heading}>
        <div>
          <strong>{file.name}</strong>
          <small>{formatBytes(file.size)}</small>
        </div>
        <span>プレビュー</span>
      </div>
      <CodeBlock lang={language} className={styles.code!}>
        {source}
      </CodeBlock>
      {truncated && (
        <p className={styles.note}>
          表示を軽くするため、先頭{previewLineLimit}行だけ表示しています。
        </p>
      )}
    </div>
  );
}
