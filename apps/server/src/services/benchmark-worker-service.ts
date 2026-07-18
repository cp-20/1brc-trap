import type { BenchmarkResult } from "@1brc/domain";
import { and, eq, sql } from "drizzle-orm";
import { err, ok, type ResultAsync } from "neverthrow";

import type { Config } from "../infrastructures/config.js";
import {
  createOrm,
  type Database,
  type Orm,
} from "../infrastructures/database.js";
import type { Logger } from "../infrastructures/logger.js";
import { serializeError } from "../infrastructures/logger.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";
import {
  benchmarkRuns,
  contestState,
  submissions,
} from "../infrastructures/schema.js";
import { AppError } from "../utils/errors.js";

type JobRow = Pick<
  typeof submissions.$inferSelect,
  "id" | "username" | "execution_kind" | "language"
>;

export function createBenchmarkWorkerService(
  database: Database,
  runner: RunnerClient,
  config: Config,
  logger: Logger,
) {
  let stopping = false;
  let running: Promise<void> | undefined;

  return {
    async start() {
      if (running) return;
      stopping = false;
      running = supervise();
    },
    async stop() {
      stopping = true;
      await running;
    },
    async finished() {
      await running;
    },
  };

  async function supervise() {
    let waitingLogged = false;
    while (!stopping) {
      const lockConnection = await database.pool.getConnection();
      const lockDatabase = createOrm(lockConnection);
      let acquired = false;
      try {
        const [lock] = await lockDatabase
          .select({
            acquired: sql<number>`GET_LOCK('1brc_benchmark_worker', 0)`,
          })
          .from(sql`DUAL`);
        acquired = lock?.acquired === 1;
        if (acquired) {
          const environment = await validateEnvironment();
          if (environment.isErr()) throw environment.error;
          logger.info("benchmark worker started", {
            environmentId: config.BENCHMARK_ENVIRONMENT_ID,
          });
          await runLoop();
        }
      } finally {
        try {
          if (acquired) {
            await lockDatabase
              .select({
                released: sql<number>`RELEASE_LOCK('1brc_benchmark_worker')`,
              })
              .from(sql`DUAL`);
          }
        } finally {
          lockConnection.release();
        }
      }

      if (!acquired && !stopping) {
        if (!waitingLogged) {
          logger.info("benchmark worker is running in another replica");
          waitingLogged = true;
        }
        await delay(2_000);
      }
    }
  }

  async function runLoop() {
    while (!stopping) {
      const heartbeat = await database.result(
        database.orm
          .update(contestState)
          .set({ worker_heartbeat_at: sql`CURRENT_TIMESTAMP(6)` })
          .where(eq(contestState.singleton_id, 1)),
      );
      if (heartbeat.isErr()) {
        logger.error("failed to update worker heartbeat", {
          error: heartbeat.error.message,
        });
        await delay(2_000);
        continue;
      }
      const claimed = await claimNext();
      if (claimed.isErr()) {
        logger.error("failed to claim queue", {
          error: claimed.error.message,
        });
        await delay(2_000);
        continue;
      }
      const job = claimed.value;
      if (!job) {
        await delay(2_000);
        continue;
      }
      if (!job.execution_kind || !job.language) {
        await retryResultUntilStopped(
          () =>
            markInfrastructureFailure(
              database,
              job.id,
              "queued submission is missing execution metadata",
            ),
          {
            isStopping: () => stopping,
            onRetry: (error) =>
              logger.error("failed to persist invalid queue entry; retrying", {
                submissionId: job.id,
                error: error.message,
              }),
          },
        );
        continue;
      }
      logger.info("benchmark started", {
        submissionId: job.id,
        username: job.username,
        language: job.language,
      });
      const result = await runner.run(job.id, job.execution_kind);
      if (result.isErr()) {
        logger.error("benchmark infrastructure failure", {
          submissionId: job.id,
          error: result.error.message,
          details: serializeError(result.error),
        });
        await retryResultUntilStopped(
          () =>
            markInfrastructureFailure(database, job.id, result.error.message),
          {
            isStopping: () => stopping,
            onRetry: (error) =>
              logger.error("failed to persist benchmark failure; retrying", {
                submissionId: job.id,
                error: error.message,
              }),
          },
        );
        continue;
      }
      await persistResult(job, result.value.public, result.value.private);
      const cleaned = await runner.cleanup(job.id);
      if (cleaned.isErr()) {
        logger.warn("failed to clean runner artifact", {
          submissionId: job.id,
          error: cleaned.error.message,
        });
      }
      logger.info("benchmark completed", {
        submissionId: job.id,
        publicVerdict: result.value.public.verdict,
        privateVerdict: result.value.private?.verdict ?? null,
      });
    }
  }

  function validateEnvironment() {
    return database.transaction(async (transaction) => {
      const [state] = await transaction
        .select({
          benchmark_environment_id: contestState.benchmark_environment_id,
        })
        .from(contestState)
        .where(eq(contestState.singleton_id, 1))
        .for("update");
      const existing = state?.benchmark_environment_id;
      if (existing && existing !== config.BENCHMARK_ENVIRONMENT_ID) {
        return err(
          new AppError(
            "infrastructure",
            "benchmark_environment_mismatch",
            `benchmark environment mismatch: database=${existing}, configured=${config.BENCHMARK_ENVIRONMENT_ID}`,
          ),
        );
      }
      await transaction
        .update(contestState)
        .set({ benchmark_environment_id: config.BENCHMARK_ENVIRONMENT_ID })
        .where(eq(contestState.singleton_id, 1));
      return ok(undefined);
    });
  }

  function claimNext() {
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select({
          id: submissions.id,
          username: submissions.username,
          execution_kind: submissions.execution_kind,
          language: submissions.language,
        })
        .from(submissions)
        .where(eq(submissions.status, "queued"))
        .orderBy(submissions.upload_started_at, submissions.id)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!job) return ok(null);
      await transaction
        .update(submissions)
        .set({
          status: "running",
          started_at: sql`CURRENT_TIMESTAMP(6)`,
          infrastructure_error: null,
        })
        .where(eq(submissions.id, job.id));
      return ok(job);
    });
  }

  function storeResult(
    job: JobRow,
    publicResult: BenchmarkResult,
    privateResult: BenchmarkResult | null,
  ) {
    return database.transaction(async (transaction) => {
      await transaction
        .delete(benchmarkRuns)
        .where(eq(benchmarkRuns.submission_id, job.id));
      await insertRuns(transaction, job.id, "public", publicResult);
      if (privateResult) {
        await insertRuns(transaction, job.id, "private", privateResult);
      }
      await transaction
        .update(submissions)
        .set({
          status: "completed",
          public_verdict: publicResult.verdict,
          public_score_ns: publicResult.medianNs,
          public_error: publicResult.error,
          private_verdict: privateResult?.verdict ?? null,
          private_score_ns: privateResult?.medianNs ?? null,
          completed_at: sql`CURRENT_TIMESTAMP(6)`,
        })
        .where(eq(submissions.id, job.id));
      if (publicResult.verdict === "accepted") {
        await transaction.execute(sql`
          UPDATE users u
            JOIN submissions candidate ON candidate.id = ${job.id}
            LEFT JOIN submissions current ON current.id = u.representative_submission_id
             SET u.representative_submission_id = candidate.id
           WHERE u.username = ${job.username}
             AND (current.id IS NULL
               OR current.upload_started_at < candidate.upload_started_at
               OR (current.upload_started_at = candidate.upload_started_at AND current.id < candidate.id))
        `);
      }
      return ok(undefined);
    });
  }

  async function persistResult(
    job: JobRow,
    publicResult: BenchmarkResult,
    privateResult: BenchmarkResult | null,
  ) {
    await retryResultUntilStopped(
      () => storeResult(job, publicResult, privateResult),
      {
        isStopping: () => stopping,
        onRetry: (error) =>
          logger.error("failed to persist benchmark result; retrying", {
            submissionId: job.id,
            error: error.message,
          }),
      },
    );
  }
}

export async function retryResultUntilStopped(
  markFailure: () => ResultAsync<unknown, AppError>,
  options: {
    isStopping: () => boolean;
    onRetry: (error: AppError) => void;
    wait?: () => Promise<void>;
  },
) {
  const wait = options.wait ?? (() => delay(2_000));
  while (!options.isStopping()) {
    const result = await markFailure();
    if (result.isOk()) return true;
    options.onRetry(result.error);
    await wait();
  }
  return false;
}

function markInfrastructureFailure(
  database: Pick<Database, "orm" | "result">,
  id: string,
  message: string,
) {
  return database.result(
    database.orm
      .update(submissions)
      .set({
        status: "infrastructure_error",
        infrastructure_error: message.slice(0, 8192),
      })
      .where(and(eq(submissions.id, id), eq(submissions.status, "running"))),
  );
}

async function insertRuns(
  transaction: Orm,
  submissionId: string,
  dataset: "public" | "private",
  result: BenchmarkResult,
) {
  const durations: readonly (string | null)[] = result.durationsNs ?? [null];
  await transaction.insert(benchmarkRuns).values(
    durations.map((duration, index) => ({
      submission_id: submissionId,
      dataset_kind: dataset,
      attempt: index + 1,
      verdict: result.verdict,
      duration_ns: duration,
    })),
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
