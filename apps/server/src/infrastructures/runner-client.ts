import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { ResultAsync } from "neverthrow";
import pRetry from "p-retry";
import type { BenchmarkResult, ExecutionKind, Language } from "@1brc/contracts";
import type { Config } from "./config.js";
import { AppError } from "../utils/errors.js";

export type RunnerJobResult = {
  public: BenchmarkResult;
  private: BenchmarkResult | null;
  environmentId: string;
};

export type RunnerEnvironment = { cpu: string; memory: string };

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
    language: Language,
  ): ResultAsync<RunnerJobResult, AppError>;
  cleanup(submissionId: string): ResultAsync<void, AppError>;
  environment(): ResultAsync<RunnerEnvironment, AppError>;
}

export async function createRunnerClient(
  config: Config,
): Promise<RunnerClient> {
  let cachedEnvironment: RunnerEnvironment | undefined;
  const privateKey = config.RUNNER_SSH_PRIVATE_KEY_PATH
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
        runnerError,
      );
    },
    run(submissionId, kind, language) {
      return ResultAsync.fromPromise(
        exec(
          connection,
          `run ${submissionId} ${kind} ${language}`,
          95 * 60_000,
        ).then((output) => {
          const parsed = JSON.parse(output) as RunnerJobResult;
          if (parsed.environmentId !== config.BENCHMARK_ENVIRONMENT_ID) {
            throw new Error(
              `runner environment mismatch: ${parsed.environmentId}`,
            );
          }
          return parsed;
        }),
        runnerError,
      );
    },
    cleanup(submissionId) {
      return ResultAsync.fromPromise(
        exec(connection, `cleanup ${submissionId}`, 30_000).then(
          () => undefined,
        ),
        runnerError,
      );
    },
    environment() {
      return ResultAsync.fromPromise(
        cachedEnvironment
          ? Promise.resolve(cachedEnvironment)
          : exec(connection, "environment", 30_000).then((output) => {
              const parsed = JSON.parse(output) as RunnerEnvironment;
              cachedEnvironment = parsed;
              return parsed;
            }),
        runnerError,
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

function runnerError(cause: unknown) {
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
        channel.stderr.on("data", (chunk: string) => (stderr += chunk));
        channel.on("close", (code: number) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else
            reject(new Error(`runner exited ${code}: ${stderr.slice(-4096)}`));
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
        channel.stderr.on("data", (chunk: string) => (stderr += chunk));
        channel.on("close", (code: number) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else
            reject(
              new Error(`runner upload exited ${code}: ${stderr.slice(-4096)}`),
            );
        });
        createReadStream(path).once("error", reject).pipe(channel);
      });
    });
  } finally {
    client.end();
  }
}
