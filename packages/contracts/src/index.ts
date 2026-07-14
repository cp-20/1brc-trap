import { z } from "zod";

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

export const activeSubmissionStatuses: readonly SubmissionStatus[] = [
  "uploading",
  "queued",
  "running",
];

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
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

export const datasetManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    contestId: z.string().min(1).max(128),
    generatedAt: z.string().datetime(),
    generatorRevision: z.string().min(1).max(128),
    artifacts: z.array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        kind: z.enum(["input", "expected"]),
        label: z.string().min(1).max(128),
        objectKey: z.string().startsWith("datasets/").max(1024),
        rows: z.number().int().nonnegative(),
        compressedBytes: z.number().int().nonnegative(),
        uncompressedBytes: z.number().int().nonnegative(),
        compressedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        uncompressedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        isPublic: z.boolean(),
      }),
    ),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (ids.has(artifact.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "artifact id must be unique",
          path: ["artifacts", index, "id"],
        });
      }
      if (keys.has(artifact.objectKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "object key must be unique",
          path: ["artifacts", index, "objectKey"],
        });
      }
      ids.add(artifact.id);
      keys.add(artifact.objectKey);
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
