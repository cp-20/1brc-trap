import type { HighlightLanguage } from "../utils/syntax-highlighter.js";
import type { SubmissionDraft } from "./submission.js";

export const executionKinds = {
  typescript: {
    label: "TypeScript",
    description: "Node.js 24で .ts ファイルを実行します。",
    extension: ".ts",
  },
  javascript: {
    label: "JavaScript",
    description: "Node.js 24で .js ファイルを実行します。",
    extension: ".js",
  },
  bun: {
    label: "Bun",
    description: "Bunで .ts または .js ファイルを実行します。",
    extension: ".ts,.js",
  },
  ruby: {
    label: "Ruby",
    description: "Ruby 4で .rb ファイルを実行します。",
    extension: ".rb",
  },
  native: {
    label: "Native",
    description:
      "ソースコードと、Ubuntu 26.04 x86_64で動くELF実行ファイルを提出します。",
    extension: undefined,
  },
} as const;

export const nativeLanguages = [
  "c",
  "cpp",
  "go",
  "rust",
  "zig",
  "csharp",
  "other",
] as const;

export const nativeBuildGuides: Record<
  (typeof nativeLanguages)[number],
  { command: string; output: string; note: string }
> = {
  c: {
    command:
      'docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src gcc:15 gcc -O3 -o program main.c',
    output: "program",
    note: "Dockerを使い、Linux x86_64上のGCCでビルドします。",
  },
  cpp: {
    command:
      'docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src gcc:15 g++ -O3 -std=c++23 -o program main.cpp',
    output: "program",
    note: "Dockerを使い、Linux x86_64上のG++でビルドします。",
  },
  go: {
    command:
      "CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o program main.go",
    output: "program",
    note: "外部Cライブラリを使わない静的なLinux amd64バイナリを生成します。",
  },
  rust: {
    command:
      'docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src rust:1.91 rustc -O -C target-cpu=x86-64 -o program main.rs',
    output: "program",
    note: "Cargoプロジェクトの場合は、同じplatformのコンテナ内でcargo build --releaseを実行してください。",
  },
  zig: {
    command:
      "zig build-exe -O ReleaseFast -target x86_64-linux-gnu -femit-bin=program main.zig",
    output: "program",
    note: "Zigのtarget指定でLinux x86_64向けにクロスコンパイルします。",
  },
  csharp: {
    command:
      "dotnet publish App.csproj -c Release -r linux-x64 --self-contained -p:PublishAot=true -o publish",
    output: "publish/App",
    note: "プロジェクト名に合わせてApp.csprojと出力ファイル名を書き換えてください。",
  },
  other: {
    command:
      "$ file ./program\nprogram: ELF 64-bit LSB executable, x86-64, ...",
    output: "program",
    note: "利用するツールチェーンでLinux x86_64 ELFを生成し、fileコマンドで形式を確認してください。",
  },
};

export function previewLanguage(
  draft: SubmissionDraft,
): HighlightLanguage | "text" {
  if (draft.executionKind === "bun") {
    return draft.source?.name.endsWith(".js") ? "javascript" : "typescript";
  }
  if (draft.executionKind !== "native") return draft.executionKind;
  const language: Partial<
    Record<SubmissionDraft["language"], HighlightLanguage>
  > = {
    c: "c",
    cpp: "cpp",
    go: "go",
    rust: "rust",
    zig: "zig",
    csharp: "csharp",
  };
  return language[draft.language] ?? "text";
}

export function defaultSourceName(draft: SubmissionDraft): string {
  if (draft.executionKind === "native") {
    const extension: Record<string, string> = {
      c: "c",
      cpp: "cpp",
      go: "go",
      rust: "rs",
      zig: "zig",
      csharp: "cs",
      other: "txt",
    };
    return `main.${extension[draft.language] ?? "txt"}`;
  }
  return draft.executionKind === "javascript"
    ? "main.js"
    : draft.executionKind === "ruby"
      ? "main.rb"
      : "main.ts";
}

export function sourceAccept(draft: SubmissionDraft): string | undefined {
  if (draft.executionKind !== "native") {
    return executionKinds[draft.executionKind].extension;
  }
  const extensions: Partial<Record<SubmissionDraft["language"], string>> = {
    c: ".c",
    cpp: ".cc,.cpp,.cxx",
    go: ".go",
    rust: ".rs",
    zig: ".zig",
    csharp: ".cs",
  };
  return extensions[draft.language];
}

export function createCurlExample(draft: SubmissionDraft): string {
  const endpoint = new URL("/api/v1/submissions", window.location.origin).href;
  const sourceName = draft.source?.name ?? defaultSourceName(draft);
  const fields = [
    `  -F executionKind=${draft.executionKind} \\`,
    ...(draft.executionKind === "native"
      ? [
          `  -F language=${draft.language} \\`,
          `  -F binary=@${draft.binary?.name ?? "program"} \\`,
        ]
      : []),
    `  -F source=@${sourceName} \\`,
  ];
  return `curl --fail-with-body \\
  -H "Authorization: Bearer $ONEBRC_ACCESS_KEY" \\
${fields.join("\n")}
  ${endpoint}`;
}
