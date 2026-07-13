import { useEffect, useState } from "react";
import type { HighlightLanguage } from "../utils/syntax-highlighter.js";
import styles from "./code-block.module.css";

export function CodeBlock({
  children,
  lang = "text",
  className = "",
}: {
  children: string;
  lang?: HighlightLanguage | "text";
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHtml(null);
    if (lang === "text") return;

    void import("../utils/syntax-highlighter.js")
      .then(({ highlightCode }) => highlightCode(children, lang))
      .then((highlighted) => {
        if (active) setHtml(highlighted);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [children, lang]);

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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
