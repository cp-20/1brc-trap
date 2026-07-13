import type { BenchmarkResult, ExecutionKind, Language } from "@1brc/contracts";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Config } from "../infrastructures/config.js";
import type { Database } from "../infrastructures/database.js";
import type { Logger } from "../infrastructures/logger.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";

type JobRow = RowDataPacket & {
  id: string;
  username: string;
  execution_kind: ExecutionKind;
  language: Language;
};

export type BenchmarkWorkerService = ReturnType<
  typeof createBenchmarkWorkerService
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
      let acquired = false;
      try {
        const [lockRows] = await lockConnection.query<
          (RowDataPacket & { acquired: number })[]
        >("SELECT GET_LOCK('1brc_benchmark_worker', 0) AS acquired");
        acquired = lockRows[0]?.acquired === 1;
        if (acquired) {
          await validateEnvironment(lockConnection);
          const recovered = await database.execute(
            `UPDATE submissions
                SET status = 'infrastructure_error', infrastructure_error = 'worker restarted during benchmark'
              WHERE status = 'running'`,
          );
          if (recovered.isErr()) throw recovered.error;
          logger.info("benchmark worker started", {
            environmentId: config.BENCHMARK_ENVIRONMENT_ID,
          });
          await runLoop();
        }
      } finally {
        try {
          if (acquired) {
            await lockConnection.query(
              "SELECT RELEASE_LOCK('1brc_benchmark_worker')",
            );
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
      await database.execute(
        "UPDATE contest_state SET worker_heartbeat_at = CURRENT_TIMESTAMP(6) WHERE singleton_id = 1",
      );
      await cleanupStaleUploads();
      const job = await claimNext();
      if (!job) {
        await delay(2_000);
        continue;
      }
      logger.info("benchmark started", {
        submissionId: job.id,
        username: job.username,
        language: job.language,
      });
      const result = await runner.run(job.id, job.execution_kind, job.language);
      if (result.isErr()) {
        logger.error("benchmark infrastructure failure", {
          submissionId: job.id,
          error: result.error.message,
        });
        await database.execute(
          "UPDATE submissions SET status = 'infrastructure_error', infrastructure_error = ? WHERE id = ?",
          [result.error.message.slice(0, 8192), job.id],
        );
        continue;
      }
      await storeResult(job, result.value.public, result.value.private);
      await runner.cleanup(job.id);
      logger.info("benchmark completed", {
        submissionId: job.id,
        publicVerdict: result.value.public.verdict,
        privateVerdict: result.value.private?.verdict ?? null,
      });
    }
  }

  async function validateEnvironment(connection: PoolConnection) {
    await connection.beginTransaction();
    try {
      const [rows] = await connection.query<
        (RowDataPacket & { benchmark_environment_id: string | null })[]
      >(
        "SELECT benchmark_environment_id FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
      );
      const existing = rows[0]?.benchmark_environment_id;
      if (existing && existing !== config.BENCHMARK_ENVIRONMENT_ID) {
        throw new Error(
          `benchmark environment mismatch: database=${existing}, configured=${config.BENCHMARK_ENVIRONMENT_ID}`,
        );
      }
      await connection.execute(
        "UPDATE contest_state SET benchmark_environment_id = ? WHERE singleton_id = 1",
        [config.BENCHMARK_ENVIRONMENT_ID],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async function cleanupStaleUploads() {
    const rows = await database.query<(RowDataPacket & { id: string })[]>(
      "SELECT id FROM submissions WHERE status = 'uploading' AND upload_started_at < CURRENT_TIMESTAMP(6) - INTERVAL 15 MINUTE",
    );
    if (rows.isErr()) return;
    for (const row of rows.value) {
      await runner.cleanup(row.id);
      await database.execute(
        "DELETE FROM submissions WHERE id = ? AND status = 'uploading'",
        [row.id],
      );
    }
  }

  async function claimNext(): Promise<JobRow | null> {
    const result = await database.transaction(async (connection) => {
      const [rows] = await connection.query<JobRow[]>(
        `SELECT id, username, execution_kind, language
           FROM submissions WHERE status = 'queued'
          ORDER BY upload_started_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const job = rows[0];
      if (!job) return null;
      await connection.execute(
        "UPDATE submissions SET status = 'running', started_at = CURRENT_TIMESTAMP(6), infrastructure_error = NULL WHERE id = ?",
        [job.id],
      );
      return job;
    });
    if (result.isErr()) {
      logger.error("failed to claim queue", { error: result.error.message });
      return null;
    }
    return result.value;
  }

  async function storeResult(
    job: JobRow,
    publicResult: BenchmarkResult,
    privateResult: BenchmarkResult | null,
  ) {
    const result = await database.transaction(async (connection) => {
      await connection.execute(
        "DELETE FROM benchmark_runs WHERE submission_id = ?",
        [job.id],
      );
      await insertRuns(connection, job.id, "public", publicResult);
      if (privateResult) {
        await insertRuns(connection, job.id, "private", privateResult);
      }
      await connection.execute(
        `UPDATE submissions
            SET status = 'completed', public_verdict = ?, public_score_ns = ?,
                public_error = ?, private_verdict = ?, private_score_ns = ?, completed_at = CURRENT_TIMESTAMP(6)
          WHERE id = ?`,
        [
          publicResult.verdict,
          publicResult.medianNs,
          publicResult.error,
          privateResult?.verdict ?? null,
          privateResult?.medianNs ?? null,
          job.id,
        ],
      );
      if (publicResult.verdict === "accepted") {
        await connection.execute(
          `UPDATE users u
            JOIN submissions candidate ON candidate.id = ?
            LEFT JOIN submissions current ON current.id = u.representative_submission_id
             SET u.representative_submission_id = candidate.id
           WHERE u.username = ?
             AND (current.id IS NULL
               OR current.upload_started_at < candidate.upload_started_at
               OR (current.upload_started_at = candidate.upload_started_at AND current.id < candidate.id))`,
          [job.id, job.username],
        );
      }
    });
    if (result.isErr()) throw result.error;
  }
}

async function insertRuns(
  connection: PoolConnection,
  submissionId: string,
  dataset: "public" | "private",
  result: BenchmarkResult,
) {
  if (result.durationsNs) {
    for (const [index, duration] of result.durationsNs.entries()) {
      await connection.execute(
        "INSERT INTO benchmark_runs (submission_id, dataset_kind, attempt, verdict, duration_ns) VALUES (?, ?, ?, ?, ?)",
        [submissionId, dataset, index + 1, result.verdict, duration],
      );
    }
  } else {
    await connection.execute(
      "INSERT INTO benchmark_runs (submission_id, dataset_kind, attempt, verdict, duration_ns) VALUES (?, ?, 1, ?, NULL)",
      [submissionId, dataset, result.verdict],
    );
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
