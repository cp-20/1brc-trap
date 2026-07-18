import { afterEach, describe, expect, it } from "bun:test";

import { createCurlExample, sourceAccept } from "./submission-options.js";
import type { SubmissionDraft } from "./submission.js";

describe("submission command", () => {
  afterEach(() => Reflect.deleteProperty(globalThis, "window"));

  it("Native提出にはlanguage・source・binaryをすべて含める", () => {
    stubWindow("https://contest.example");
    const command = createCurlExample(
      draft({
        executionKind: "native",
        language: "rust",
        source: new File(["fn main() {}"], "main.rs"),
        binary: new File(["binary"], "program"),
      }),
    );

    expect(command).toContain("-F executionKind=native");
    expect(command).toContain("-F language=rust");
    expect(command).toContain("-F source=@main.rs");
    expect(command).toContain("-F binary=@program");
    expect(command).toContain("https://contest.example/api/v1/submissions");
  });

  it("script提出ではlanguageとbinaryを送らず、runtimeに合う拡張子だけを許可する", () => {
    stubWindow("https://contest.example");
    const typescript = draft({ executionKind: "typescript" });
    const command = createCurlExample(typescript);

    expect(command).toContain("-F executionKind=typescript");
    expect(command).not.toContain("-F language=");
    expect(command).not.toContain("-F binary=");
    expect(sourceAccept(typescript)).toBe(".ts");
  });
});

function stubWindow(origin: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin } },
  });
}

function draft(overrides: Partial<SubmissionDraft>): SubmissionDraft {
  return {
    executionKind: "typescript",
    language: "cpp",
    source: null,
    binary: null,
    ...overrides,
  };
}
