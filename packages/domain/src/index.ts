import { z } from "zod";

export const benchmarkPolicy = {
  repetitions: 3,
  slowFirstAttemptSeconds: 60,
  timeoutSeconds: 900,
  pidLimit: 4096,
  stdioLimitBytes: 1024 * 1024,
  outputLimitBytes: 256 * 1024 * 1024,
} as const;

export const submissionPolicy = {
  sourceLimitBytes: 1024 * 1024,
  binaryLimitBytes: 64 * 1024 * 1024,
  uploadTimeoutMs: 15 * 60 * 1000,
} as const;

export function shouldStopAfterFirstAttempt(
  attempt: number,
  durationNs: string,
) {
  const threshold =
    BigInt(benchmarkPolicy.slowFirstAttemptSeconds) * 1_000_000_000n;
  return attempt === 1 && BigInt(durationNs) > threshold;
}

export const executionKinds = [
  "native",
  "javascript",
  "typescript",
  "bun",
  "ruby",
] as const;
export const executionKindSchema = z.enum(executionKinds);
export type ExecutionKind = z.infer<typeof executionKindSchema>;

export const languages = [
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
] as const;
export const languageSchema = z.enum(languages);
export type Language = z.infer<typeof languageSchema>;

export const submissionStatuses = [
  "uploading",
  "queued",
  "running",
  "completed",
  "rejected",
  "infrastructure_error",
  "disqualified",
] as const;
export const submissionStatusSchema = z.enum(submissionStatuses);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const verdicts = [
  "accepted",
  "wrong_answer",
  "runtime_error",
  "time_limit",
  "output_limit",
  "invalid_submission",
  "infrastructure_error",
  "disqualified",
] as const;
export const verdictSchema = z.enum(verdicts);
export type Verdict = z.infer<typeof verdictSchema>;

export const sourceExtensions: Readonly<Record<Language, readonly string[]>> = {
  c: [".c"],
  cpp: [".cc", ".cpp", ".cxx"],
  go: [".go"],
  rust: [".rs"],
  zig: [".zig"],
  csharp: [".cs"],
  other: [],
  javascript: [".js"],
  typescript: [".ts"],
  bun: [".js", ".ts"],
  ruby: [".rb"],
};

export type BenchmarkResult = {
  verdict: Verdict;
  durationsNs: [string] | [string, string, string] | null;
  medianNs: string | null;
  error: string | null;
};

export type LeaderboardEntry = {
  rank: number | null;
  rankChange: number | null;
  username: string;
  submissionId: string;
  language: Language;
  scoreNs: string | null;
  verdict: Verdict;
  submittedAt: string;
  sourceAvailable: boolean;
};

const datasetArtifactSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  kind: z.enum(["input", "expected"]),
  label: z.string().min(1).max(128),
  objectKey: z.string().startsWith("datasets/").max(1024),
  rows: z.number().int().positive(),
  compressedBytes: z.number().int().positive(),
  uncompressedBytes: z.number().int().positive(),
  compressedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  uncompressedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  isPublic: z.boolean(),
});

export const datasetManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    contestId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    generatedAt: z.string().datetime(),
    generatorRevision: z.string().min(1).max(128),
    artifacts: z.array(datasetArtifactSchema).min(4),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    const pairs = new Map<string, Set<"input" | "expected">>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (ids.has(artifact.id)) {
        context.addIssue({
          code: "custom",
          message: "artifact id must be unique",
          path: ["artifacts", index, "id"],
        });
      }
      if (keys.has(artifact.objectKey)) {
        context.addIssue({
          code: "custom",
          message: "object key must be unique",
          path: ["artifacts", index, "objectKey"],
        });
      }
      if (!artifact.id.endsWith(`-${artifact.kind}`)) {
        context.addIssue({
          code: "custom",
          message: `artifact id must end with -${artifact.kind}`,
          path: ["artifacts", index, "id"],
        });
      }
      const scope = artifact.isPublic ? "public" : "private";
      if (
        !artifact.objectKey.startsWith(
          `datasets/${manifest.contestId}/${scope}/`,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `object key must be under the ${scope} dataset prefix`,
          path: ["artifacts", index, "objectKey"],
        });
      }
      const pairKey = `${scope}:${artifact.rows}`;
      const kinds = pairs.get(pairKey) ?? new Set();
      if (kinds.has(artifact.kind)) {
        context.addIssue({
          code: "custom",
          message: "dataset rows and kind must be unique within a scope",
          path: ["artifacts", index, "kind"],
        });
      }
      kinds.add(artifact.kind);
      pairs.set(pairKey, kinds);
      ids.add(artifact.id);
      keys.add(artifact.objectKey);
    }
    for (const [pairKey, kinds] of pairs) {
      if (!kinds.has("input") || !kinds.has("expected")) {
        context.addIssue({
          code: "custom",
          message: `${pairKey} must contain both input and expected artifacts`,
          path: ["artifacts"],
        });
      }
    }
    if (![...pairs.keys()].some((key) => key.startsWith("public:"))) {
      context.addIssue({
        code: "custom",
        message: "at least one public dataset is required",
        path: ["artifacts"],
      });
    }
    if (![...pairs.keys()].some((key) => key.startsWith("private:"))) {
      context.addIssue({
        code: "custom",
        message: "at least one private dataset is required",
        path: ["artifacts"],
      });
    }
  });
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export function inferLanguage(
  kind: ExecutionKind,
  requested?: string,
): Language | null {
  if (
    kind === "javascript" ||
    kind === "typescript" ||
    kind === "bun" ||
    kind === "ruby"
  )
    return kind;
  const parsed = languageSchema.safeParse(requested);
  if (
    !parsed.success ||
    ["javascript", "typescript", "bun", "ruby"].includes(parsed.data)
  )
    return null;
  return parsed.data;
}
