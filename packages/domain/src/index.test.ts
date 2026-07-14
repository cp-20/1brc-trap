import { describe, expect, it } from "vitest";
import {
  datasetManifestSchema,
  executionKindSchema,
  inferLanguage,
  shouldStopAfterFirstAttempt,
  sourceExtensions,
} from "./index.js";

describe("Bun提出形式", () => {
  it("Bunを実行形式と言語として扱う", () => {
    expect(executionKindSchema.parse("bun")).toBe("bun");
    expect(inferLanguage("bun")).toBe("bun");
  });

  it("JavaScriptとTypeScriptの単一source fileを許可する", () => {
    expect(sourceExtensions.bun).toEqual([".js", ".ts"]);
  });
});

describe("benchmark policy", () => {
  it("60秒を超えた初回計測だけで打ち切る", () => {
    expect(shouldStopAfterFirstAttempt(1, "60000000000")).toBe(false);
    expect(shouldStopAfterFirstAttempt(1, "60000000001")).toBe(true);
    expect(shouldStopAfterFirstAttempt(2, "60000000001")).toBe(false);
  });
});

describe("dataset manifest", () => {
  const artifact = (
    id: string,
    kind: "input" | "expected",
    isPublic: boolean,
  ) => ({
    id,
    kind,
    label: id,
    objectKey: `datasets/contest/${isPublic ? "public" : "private"}/${id}.zst`,
    rows: isPublic ? 100 : 1000,
    compressedBytes: 1,
    uncompressedBytes: 1,
    compressedSha256: "a".repeat(64),
    uncompressedSha256: "b".repeat(64),
    isPublic,
  });
  const manifest = {
    schemaVersion: 1 as const,
    contestId: "contest",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generatorRevision: "test",
    artifacts: [
      artifact("public-small-input", "input", true),
      artifact("public-small-expected", "expected", true),
      artifact("private-full-input", "input", false),
      artifact("private-full-expected", "expected", false),
    ],
  };

  it("input/expectedが揃ったpublic/private datasetを受理する", () => {
    expect(datasetManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("kindとID、scopeとobject key、input/expectedの組を検証する", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[0]!.id = "public-small-expected";
    invalid.artifacts[0]!.objectKey =
      "datasets/contest/private/public-small-input.zst";
    expect(datasetManifestSchema.safeParse(invalid).success).toBe(false);
  });
});
