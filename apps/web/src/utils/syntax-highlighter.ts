import {
  createBundledHighlighter,
  createSingletonShorthands,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

const languages = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  go: () => import("@shikijs/langs/go"),
  javascript: () => import("@shikijs/langs/javascript"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  typescript: () => import("@shikijs/langs/typescript"),
  zig: () => import("@shikijs/langs/zig"),
} as const;

const themes = {
  "github-dark": () => import("@shikijs/themes/github-dark"),
} as const;

export type HighlightLanguage = keyof typeof languages;

const createHighlighter = /* @__PURE__ */ createBundledHighlighter({
  langs: languages,
  themes,
  engine: () => createJavaScriptRegexEngine(),
});

const { codeToHtml } =
  /* @__PURE__ */ createSingletonShorthands(createHighlighter);

export function highlightCode(code: string, language: HighlightLanguage) {
  return codeToHtml(code, { lang: language, theme: "github-dark" });
}
