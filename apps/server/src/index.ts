import { createApp } from "./app.js";
import { loadConfig } from "./infrastructures/config.js";
import { createDatabase } from "./infrastructures/database.js";
import { createLogger } from "./infrastructures/logger.js";
import { migrateDatabase } from "./infrastructures/migrations.js";
import { createR2Signer } from "./infrastructures/r2-signer.js";
import { createRunnerClient } from "./infrastructures/runner-client.js";
import { createAccountRepository } from "./repositories/account-repository.js";
import { createAdminRepository } from "./repositories/admin-repository.js";
import { createContestRepository } from "./repositories/contest-repository.js";
import { createSubmissionRepository } from "./repositories/submission-repository.js";
import { createAccountService } from "./services/account-service.js";
import { createAdminService } from "./services/admin-service.js";
import { createBenchmarkWorkerService } from "./services/benchmark-worker-service.js";
import { createContestService } from "./services/contest-service.js";
import { createSubmissionQueryService } from "./services/submission-query-service.js";
import { createSubmissionService } from "./services/submission-service.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
await migrateDatabase(config);
logger.info("MariaDB migration completed");
const database = createDatabase(config);
const runner = await createRunnerClient(config, logger);
const contestRepository = createContestRepository(database);
const submissionRepository = createSubmissionRepository(database);
const administrationRepository = createAdminRepository(database);
const accountRepository = createAccountRepository(database);
const datasets = createR2Signer(config);
const app = createApp({
  config,
  database,
  authentication: accountRepository,
  logger,
  contest: createContestService(contestRepository, datasets, config),
  account: createAccountService(accountRepository),
  administration: createAdminService(
    administrationRepository,
    submissionRepository,
    config,
    datasets,
  ),
  submissions: createSubmissionService(submissionRepository, runner, config),
  submissionQueries: createSubmissionQueryService(
    submissionRepository,
    contestRepository,
  ),
});
const worker = createBenchmarkWorkerService(database, runner, config, logger);
await worker.start();

const server = Bun.serve({
  fetch(request, runtime) {
    const path = new URL(request.url).pathname;
    if (
      path.endsWith("/events") ||
      (request.method === "POST" && path === "/api/v1/submissions")
    ) {
      runtime.timeout(request, 0);
    }
    return app.fetch(request);
  },
  hostname: "0.0.0.0",
  port: config.PORT,
});
logger.info("1BRC APIを起動しました", {
  port: config.PORT,
  environmentId: config.BENCHMARK_ENVIRONMENT_ID,
});
void worker.finished().catch((error: unknown) => {
  logger.error("benchmark worker stopped unexpectedly", {
    error: error instanceof Error ? error.message : String(error),
  });
  void shutdown("worker failure", 1);
});

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("1BRC APIを停止します", { signal });
  await Promise.allSettled([server.stop(true), worker.stop()]);
  await database.close();
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
