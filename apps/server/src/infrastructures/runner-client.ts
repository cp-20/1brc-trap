import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  benchmarkPolicy,
  runnerJobResultSchema,
  type ExecutionKind,
  type RunnerJobResult,
} from "@1brc/domain";
import { ResultAsync } from "neverthrow";
import pRetry from "p-retry";
import { Client, type ConnectConfig } from "ssh2";

import { AppError } from "../utils/errors.js";
import type { Config } from "./config.js";
import { serializeError, type Logger } from "./logger.js";

export interface RunnerClient {
  upload(
    submissionId: string,
    kind: ExecutionKind,
    sha256: string,
    path: string,
  ): ResultAsync<void, AppError>;
  run(
    submissionId: string,
    kind: ExecutionKind,
  ): ResultAsync<RunnerJobResult, AppError>;
  cleanup(submissionId: string): ResultAsync<void, AppError>;
}

export async function createRunnerClient(
  config: Config,
  logger: Logger,
): Promise<RunnerClient> {
  const privateKey = config.RUNNER_SSH_PRIVATE_KEY_BASE64
    ? Buffer.from(config.RUNNER_SSH_PRIVATE_KEY_BASE64, "base64").toString(
        "utf8",
      )
    : config.RUNNER_SSH_PRIVATE_KEY_PATH
      ? await readFile(config.RUNNER_SSH_PRIVATE_KEY_PATH, "utf8")
      : undefined;
  const connection: ConnectConfig = {
    host: config.RUNNER_SSH_HOST,
    port: config.RUNNER_SSH_PORT,
    username: config.RUNNER_SSH_USER,
    readyTimeout: 15_000,
    ...(config.RUNNER_SSH_HOST_KEY_SHA256
      ? { hostVerifier: createHostVerifier(config.RUNNER_SSH_HOST_KEY_SHA256) }
      : {}),
    ...(privateKey
      ? { privateKey }
      : { password: config.RUNNER_SSH_PASSWORD! }),
  };

  return {
    upload(submissionId, kind, digest, path) {
      return ResultAsync.fromPromise(
        execWithInput(
          connection,
          `upload ${submissionId} ${kind} ${digest}`,
          path,
          15 * 60_000,
        ).then(() => undefined),
        (cause) => runnerError(logger, "upload", submissionId, cause),
      );
    },
    run(submissionId, kind) {
      return ResultAsync.fromPromise(
        exec(
          connection,
          `run ${submissionId} ${kind}`,
          (benchmarkPolicy.repetitions * 2 * benchmarkPolicy.timeoutSeconds +
            5 * 60) *
            1000,
        ).then((output) => {
          const parsed = runnerJobResultSchema.parse(JSON.parse(output));
          if (parsed.environmentId !== config.BENCHMARK_ENVIRONMENT_ID) {
            throw new Error(
              `runner environment mismatch: ${parsed.environmentId}`,
            );
          }
          return parsed;
        }),
        (cause) => runnerError(logger, "run", submissionId, cause),
      );
    },
    cleanup(submissionId) {
      return ResultAsync.fromPromise(
        exec(connection, `cleanup ${submissionId}`, 30_000).then(
          () => undefined,
        ),
        (cause) => runnerError(logger, "cleanup", submissionId, cause),
      );
    },
  };
}

function createHostVerifier(expectedFingerprint: string) {
  const expected = expectedFingerprint
    .replace(/^SHA256:/, "")
    .replace(/=+$/, "");
  return (key: Buffer) => {
    const actual = createHash("sha256")
      .update(key)
      .digest("base64")
      .replace(/=+$/, "");
    return actual === expected;
  };
}

function runnerError(
  logger: Logger,
  operation: "upload" | "run" | "cleanup",
  submissionId: string,
  cause: unknown,
) {
  logger.error("runner operation failed", {
    operation,
    submissionId,
    cause: serializeError(cause),
  });
  return new AppError(
    "infrastructure",
    "runner_unavailable",
    "計測環境に接続できませんでした。しばらく待ってから再度提出してください",
    cause,
  );
}

function connect(options: ConnectConfig): Promise<Client> {
  return pRetry(() => connectOnce(options), {
    retries: 6,
    minTimeout: 250,
    maxTimeout: 2_500,
    maxRetryTime: 15_000,
    randomize: true,
    shouldRetry: ({ error }) => isTransientConnectionError(error),
  });
}

function connectOnce(options: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(options);
  });
}

function isTransientConnectionError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].includes(
    code ?? "",
  );
}

async function exec(
  options: ConnectConfig,
  command: string,
  timeoutMs: number,
): Promise<string> {
  const client = await connect(options);
  try {
    return await new Promise<string>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) return reject(error);
        const timer = setTimeout(() => {
          channel.close();
          reject(
            new Error(`runner command timed out: ${command.split(" ", 1)[0]}`),
          );
        }, timeoutMs);
        let stdout = "";
        let stderr = "";
        channel.setEncoding("utf8");
        channel.on("data", (chunk: string) => (stdout += chunk));
        channel.stderr.setEncoding("utf8");
        channel.stderr.on(
          "data",
          (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-4096)),
        );
        channel.on("close", (code: number) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(new Error(`runner exited ${code}: ${stderr}`));
        });
      });
    });
  } finally {
    client.end();
  }
}

async function execWithInput(
  options: ConnectConfig,
  command: string,
  path: string,
  timeoutMs: number,
): Promise<void> {
  const client = await connect(options);
  try {
    await new Promise<void>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) return reject(error);
        const timer = setTimeout(() => {
          channel.close();
          reject(new Error("runner upload timed out"));
        }, timeoutMs);
        let stderr = "";
        channel.resume();
        channel.stderr.setEncoding("utf8");
        channel.stderr.on(
          "data",
          (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-4096)),
        );
        channel.on("close", (code: number) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`runner upload exited ${code}: ${stderr}`));
        });
        createReadStream(path).once("error", reject).pipe(channel);
      });
    });
  } finally {
    client.end();
  }
}
