import { describe, expect, it } from "bun:test";

import {
  benchmarkAttemptResultSchema,
  benchmarkResultSchema,
  compareNanoseconds,
  datasetManifestSchema,
  executionKindSchema,
  hasContestStarted,
  inferLanguage,
  isSubmissionActive,
  isSubmissionOpen,
  nativeLanguages,
  runnerJobResultSchema,
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

describe("submission rules", () => {
  it("Nativeで選べる言語だけを共有する", () => {
    expect(nativeLanguages).toEqual([
      "c",
      "cpp",
      "go",
      "rust",
      "zig",
      "csharp",
      "other",
    ]);
    expect(inferLanguage("native", "rust")).toBe("rust");
    expect(inferLanguage("native", "typescript")).toBeNull();
  });

  it("アップロードから計測中までを処理中とする", () => {
    expect(isSubmissionActive("uploading")).toBe(true);
    expect(isSubmissionActive("queued")).toBe(true);
    expect(isSubmissionActive("running")).toBe(true);
    expect(isSubmissionActive("completed")).toBe(false);
  });
});

describe("contest schedule", () => {
  const contest = {
    startAt: "2026-07-20T00:00:00.000Z",
    endAt: "2026-07-21T00:00:00.000Z",
  };

  it("開始前は提出を閉じ、開始後は終了時刻を過ぎても受け付ける", () => {
    expect(
      hasContestStarted(contest, new Date("2026-07-19T23:59:59.999Z")),
    ).toBe(false);
    expect(
      isSubmissionOpen(contest, new Date("2026-07-20T00:00:00.000Z")),
    ).toBe(true);
    expect(
      isSubmissionOpen(contest, new Date("2026-07-21T00:00:00.000Z")),
    ).toBe(true);
    expect(
      isSubmissionOpen(contest, new Date("2026-07-21T00:00:00.001Z")),
    ).toBe(true);
  });
});

describe("nanosecond scores", () => {
  it("Numberの精度を超える値も比較する", () => {
    expect(compareNanoseconds("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareNanoseconds("10", "10")).toBe(0);
  });
});

describe("benchmark policy", () => {
  it("60秒を超えた初回計測だけで打ち切る", () => {
    expect(shouldStopAfterFirstAttempt(1, "60000000000")).toBe(false);
    expect(shouldStopAfterFirstAttempt(1, "60000000001")).toBe(true);
    expect(shouldStopAfterFirstAttempt(2, "60000000001")).toBe(false);
  });
});

describe("benchmark result protocol", () => {
  const accepted = {
    verdict: "accepted" as const,
    durationsNs: ["1", "3", "2"] as [string, string, string],
    medianNs: "2",
    error: null,
  };

  it("acceptedだけが計測時間を持ち、失敗結果では時間を公開しない", () => {
    expect(benchmarkResultSchema.safeParse(accepted).success).toBe(true);
    expect(
      benchmarkResultSchema.safeParse({
        verdict: "wrong_answer",
        durationsNs: null,
        medianNs: null,
        error: "mismatch",
      }).success,
    ).toBe(true);
    expect(
      benchmarkResultSchema.safeParse({
        verdict: "runtime_error",
        durationsNs: ["1"],
        medianNs: "1",
        error: "failed",
      }).success,
    ).toBe(false);
  });

  it("containerの1試行結果とrunner-server間の結果を同じschemaで検証する", () => {
    expect(
      benchmarkAttemptResultSchema.safeParse({
        verdict: "accepted",
        durationNs: "123",
        error: null,
      }).success,
    ).toBe(true);
    expect(
      runnerJobResultSchema.safeParse({
        public: accepted,
        private: null,
        environmentId: "benchmark-v2",
      }).success,
    ).toBe(true);
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

  it("artifact IDの末尾をkindと一致させる", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[0]!.id = "public-small-data";
    expect(issues(invalid)).toContain("artifact id must end with -input");
  });

  it("public/privateの区分とobject keyのscopeを一致させる", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[0]!.objectKey =
      "datasets/contest/private/public-small-input.zst";
    expect(issues(invalid)).toContain(
      "object key must be under the public dataset prefix",
    );
  });

  it("DBとR2で同じkeyを指すようobject keyをASCIIに限定する", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[0]!.objectKey = "datasets/contest/public/入力-input.zst";
    expect(datasetManifestSchema.safeParse(invalid).success).toBe(false);
  });

  it("同じscopeと行数にinputとexpectedの両方を要求する", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[1] = artifact("public-small-copy-input", "input", true);
    expect(issues(invalid)).toContain(
      "public:100 must contain both input and expected artifacts",
    );
  });

  it("公開計測と非公開計測のdatasetをどちらも要求する", () => {
    const invalid = structuredClone(manifest);
    for (const item of invalid.artifacts.filter(
      (candidate) => !candidate.isPublic,
    )) {
      item.isPublic = true;
      item.objectKey = item.objectKey.replace("/private/", "/public/");
    }
    expect(issues(invalid)).toContain(
      "at least one private dataset is required",
    );
  });

  it("artifact IDとobject keyの重複を拒否する", () => {
    const invalid = structuredClone(manifest);
    invalid.artifacts[1]!.id = invalid.artifacts[0]!.id;
    invalid.artifacts[1]!.objectKey = invalid.artifacts[0]!.objectKey;
    expect(issues(invalid)).toEqual(
      expect.arrayContaining([
        "artifact id must be unique",
        "object key must be unique",
      ]),
    );
  });

  function issues(value: unknown) {
    const result = datasetManifestSchema.safeParse(value);
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.message);
  }
});
