import type { Language, Verdict } from "@1brc/contracts";

const languageLabels: Record<Language, string> = {
  c: "C",
  cpp: "C++",
  go: "Go",
  rust: "Rust",
  zig: "Zig",
  csharp: "C#",
  other: "Other",
  javascript: "JavaScript",
  typescript: "TypeScript",
  bun: "Bun",
  ruby: "Ruby",
};

const verdictLabels: Record<Verdict, string> = {
  accepted: "正解",
  wrong_answer: "不正解",
  runtime_error: "実行時エラー",
  time_limit: "時間切れ",
  output_limit: "出力制限超過",
  invalid_submission: "無効な提出",
  infrastructure_error: "計測エラー",
  disqualified: "失格",
};

export function languageLabel(language: Language | string): string {
  return languageLabels[language as Language] ?? language;
}

export function verdictLabel(verdict: Verdict): string {
  return verdictLabels[verdict];
}

export const selectableLanguages: Language[] = [
  "c",
  "cpp",
  "go",
  "rust",
  "zig",
  "csharp",
  "other",
  "javascript",
  "typescript",
  "bun",
  "ruby",
];
