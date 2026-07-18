import { memo, useEffect, useMemo, useState } from "react";

import type { HighlightLanguage } from "../utils/syntax-highlighter.js";

import styles from "./code-block.module.css";

export const CodeBlock = memo(function CodeBlock({
  children,
  lang = "text",
  className = "",
  diff = false,
}: {
  children: string;
  lang?: HighlightLanguage | "text";
  className?: string;
  diff?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const markup = useMemo(() => ({ __html: html ?? "" }), [html]);

  useEffect(() => {
    let active = true;
    setHtml(null);
    if (lang === "text") return;

    void import("../utils/syntax-highlighter.js")
      .then(({ highlightCode, highlightDiff }) =>
        diff ? highlightDiff(children, lang) : highlightCode(children, lang),
      )
      .then((highlighted) => {
        if (active) setHtml(highlighted);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [children, diff, lang]);

  if (!html) {
    return (
      <pre className={`${styles.block} code-block ${className}`}>
        <code>{children}</code>
      </pre>
    );
  }
  return (
    <div
      className={`${styles.block} ${styles.highlighted} code-block highlighted-code ${className}`}
      dangerouslySetInnerHTML={markup}
    />
  );
});
