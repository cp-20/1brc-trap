import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  benchmarkAttemptResultSchema,
  benchmarkPolicy,
  compareNanoseconds,
  executionKindSchema,
  shouldStopAfterFirstAttempt,
  submissionPolicy,
  type BenchmarkResult,
} from "@1brc/domain";
import { execa } from "execa";
import { z } from "zod";

import { compareOutput } from "./compare.js";
import { buildContainerCreateArgs } from "./container-command.js";
import { runWithFileLock, waitForFileLock } from "./run-lock.js";

const config = z
  .object({
    RUNNER_ROOT: z.string().default("/var/lib/1brc"),
    RUNNER_WORK_ROOT: z.string().default("/var/lib/1brc/work"),
    RUNNER_IMAGE: z.string().min(1),
    RUNNER_PUBLIC_INPUT: z.string().min(1),
    RUNNER_PUBLIC_EXPECTED: z.string().min(1),
    RUNNER_PRIVATE_INPUT: z.string().min(1),
    RUNNER_PRIVATE_EXPECTED: z.string().min(1),
    BENCHMARK_ENVIRONMENT_ID: z.string().min(1),
  })
  .parse(process.env);

const commandText =
  process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(" ");
const parts = commandText.trim().split(/\s+/);
const command = parts.shift();

try {
  switch (command) {
    case "upload":
      await upload(parts);
      break;
    case "run":
      if (process.env.ONEBRC_RUN_LOCKED === "1") await run(parts);
      else await runUnderLock();
      break;
    case "cleanup":
      await cleanup(parts);
      break;
    case "cancel":
      await cancel(parts);
      break;
    default:
      throw new Error("unsupported runner command");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function upload(args: string[]) {
  const [id, kindValue, wantedDigest] = args;
  validateId(id);
  const kind = executionKindSchema.parse(kindValue);
  if (!wantedDigest || !/^[a-f0-9]{64}$/.test(wantedDigest))
    throw new Error("invalid digest");
  const directory = jobDirectory(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, "artifact.uploading");
  const final = artifactPath(id, kind);
  const digest = createHash("sha256");
  let bytes = 0;
  const limit =
    kind === "native"
      ? submissionPolicy.binaryLimitBytes
      : submissionPolicy.sourceLimitBytes;
  process.stdin.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    digest.update(chunk);
    if (bytes > limit)
      process.stdin.destroy(new Error("artifact size limit exceeded"));
  });
  await pipeline(
    process.stdin,
    createWriteStream(temporary, { mode: kind === "native" ? 0o755 : 0o644 }),
  );
  if (digest.digest("hex") !== wantedDigest)
    throw new Error("artifact checksum mismatch");
  await rm(final, { force: true });
  await import("node:fs/promises").then(({ rename }) =>
    rename(temporary, final),
  );
  await chmod(final, kind === "native" ? 0o755 : 0o644);
  process.stdout.write("ok\n");
}

async function run(args: string[]) {
  const [id, kindValue] = args;
  validateId(id);
  const kind = executionKindSchema.parse(kindValue);
  await access(artifactPath(id, kind));
  const publicResult = await benchmark(
    id,
    kind,
    "public",
    config.RUNNER_PUBLIC_INPUT,
    config.RUNNER_PUBLIC_EXPECTED,
  );
  const privateResult =
    publicResult.verdict === "accepted"
      ? await benchmark(
          id,
          kind,
          "private",
          config.RUNNER_PRIVATE_INPUT,
          config.RUNNER_PRIVATE_EXPECTED,
        )
      : null;
  process.stdout.write(
    `${JSON.stringify({
      public: publicResult,
      private: privateResult,
      environmentId: config.BENCHMARK_ENVIRONMENT_ID,
    })}\n`,
  );
}

async function runUnderLock() {
  await mkdir(config.RUNNER_ROOT, { recursive: true });
  const exitCode = await runWithFileLock(
    join(config.RUNNER_ROOT, "run.lock"),
    process.execPath,
    [import.meta.filename, ...process.argv.slice(2)],
    { ...process.env, ONEBRC_RUN_LOCKED: "1" },
  );
  if (exitCode === "busy") throw new Error("runner is busy");
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function benchmark(
  id: string,
  kind: string,
  dataset: "public" | "private",
  input: string,
  expected: string,
): Promise<BenchmarkResult> {
  const cachedInput = await cacheInput(dataset, input);
  const durations: string[] = [];
  for (let attempt = 1; attempt <= benchmarkPolicy.repetitions; attempt += 1) {
    await throwIfCancelled(id);
    const attemptResult = await runAttempt(
      id,
      kind,
      dataset,
      attempt,
      cachedInput,
    );
    if (attemptResult.verdict !== "accepted") {
      await removeAttemptWork(id, dataset, attempt);
      return {
        verdict: attemptResult.verdict,
        durationsNs: null,
        medianNs: null,
        error: attemptResult.error,
      };
    }
    const comparison = await compareOutput(attemptResult.outputPath, expected);
    await removeAttemptWork(id, dataset, attempt);
    if (comparison.isErr())
      return {
        verdict: "wrong_answer",
        durationsNs: null,
        medianNs: null,
        error: comparison.error.message,
      };
    durations.push(attemptResult.durationNs);
    if (shouldStopAfterFirstAttempt(attempt, attemptResult.durationNs)) break;
  }
  const sorted = [...durations].sort(compareNanoseconds);
  return {
    verdict: "accepted",
    durationsNs: durations as [string] | [string, string, string],
    medianNs: sorted[Math.floor(sorted.length / 2)]!,
    error: null,
  };
}

async function cacheInput(dataset: "public" | "private", input: string) {
  const cached = join(config.RUNNER_ROOT, "ram-data", `${dataset}.csv`);
  const sourceStats = await stat(input);
  const cachedStats = await stat(cached).catch(() => null);
  if (
    cachedStats?.size === sourceStats.size &&
    Math.trunc(cachedStats.mtimeMs) === Math.trunc(sourceStats.mtimeMs)
  )
    return cached;

  await rm(cached, { force: true });
  try {
    await copyFile(input, cached);
    await utimes(cached, sourceStats.atime, sourceStats.mtime);
    await chmod(cached, 0o444);
    return cached;
  } catch (error) {
    await rm(cached, { force: true });
    throw error;
  }
}

async function runAttempt(
  id: string,
  kind: string,
  dataset: string,
  attempt: number,
  input: string,
) {
  const container = `onebrc-${id}-${dataset}-${attempt}-${randomUUID().slice(0, 6)}`;
  const artifact = artifactPath(id, kind);
  const containerArtifact = `/submission/artifact${artifactExtension(kind)}`;
  const workDirectory = join(
    config.RUNNER_WORK_ROOT,
    id,
    `${dataset}-${attempt}`,
  );
  await rm(workDirectory, { recursive: true, force: true });
  await mkdir(workDirectory, { recursive: true, mode: 0o777 });
  await chmod(workDirectory, 0o1777);
  const output = join(workDirectory, "output.txt");
  const createArgs = buildContainerCreateArgs({
    container,
    workDirectory,
    artifact,
    containerArtifact,
    input,
    image: config.RUNNER_IMAGE,
    kind,
  });
  await execute("docker", createArgs, 60_000);
  try {
    const raw = await execute(
      "docker",
      ["start", "-a", container],
      (benchmarkPolicy.timeoutSeconds + 30) * 1000,
      benchmarkPolicy.stdioLimitBytes,
    );
    const result = benchmarkAttemptResultSchema.parse(JSON.parse(raw.trim()));
    if (result.verdict === "accepted") {
      const outputStats = await stat(output);
      if (outputStats.size > benchmarkPolicy.outputLimitBytes)
        return {
          verdict: "output_limit" as const,
          durationNs: null,
          error: "出力サイズの上限を超えました",
          outputPath: output,
        };
    }
    return { ...result, outputPath: output };
  } finally {
    await execute("docker", ["rm", "-f", container], 30_000).catch(
      () => undefined,
    );
  }
}

async function cleanup(args: string[]) {
  const [id] = args;
  validateId(id);
  await rm(jobDirectory(id), { recursive: true, force: true });
  await rm(join(config.RUNNER_WORK_ROOT, id), {
    recursive: true,
    force: true,
  });
  process.stdout.write("ok\n");
}

async function cancel(args: string[]) {
  const [id] = args;
  validateId(id);
  await mkdir(jobDirectory(id), { recursive: true, mode: 0o700 });
  await writeFile(join(jobDirectory(id), "cancelled"), "", { mode: 0o600 });
  const removeContainers = async () => {
    const containers = await execute(
      "docker",
      ["ps", "-aq", "--filter", `name=onebrc-${id}-`],
      30_000,
    );
    const ids = containers.trim().split(/\s+/).filter(Boolean);
    if (ids.length > 0) await execute("docker", ["rm", "-f", ...ids], 30_000);
  };
  await removeContainers();
  await waitForFileLock(
    join(config.RUNNER_ROOT, "run.lock"),
    30_000,
    removeContainers,
  );
  await cleanup([id]);
}

async function throwIfCancelled(id: string) {
  const cancelled = await access(join(jobDirectory(id), "cancelled")).then(
    () => true,
    () => false,
  );
  if (cancelled) throw new Error("job cancelled");
}

function jobDirectory(id: string) {
  return join(config.RUNNER_ROOT, "jobs", id);
}
function artifactPath(id: string, kind: string) {
  return join(jobDirectory(id), `artifact${artifactExtension(kind)}`);
}
function artifactExtension(kind: string) {
  return kind === "typescript" || kind === "bun"
    ? ".ts"
    : kind === "javascript"
      ? ".js"
      : kind === "ruby"
        ? ".rb"
        : "";
}
async function removeAttemptWork(
  id: string,
  dataset: "public" | "private",
  attempt: number,
) {
  await rm(join(config.RUNNER_WORK_ROOT, id, `${dataset}-${attempt}`), {
    recursive: true,
    force: true,
  });
}
function validateId(id: string | undefined): asserts id is string {
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error("invalid submission id");
}

async function execute(
  executable: string,
  args: string[],
  timeout: number,
  maxOutput = 256 * 1024,
): Promise<string> {
  const { stdout } = await execa(executable, args, {
    stdin: "ignore",
    timeout,
    maxBuffer: maxOutput,
  });
  return stdout;
}
