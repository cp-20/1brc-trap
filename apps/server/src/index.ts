import { createApp } from "./app.js";
import { loadConfig } from "./infrastructures/config.js";
import { createDatabase } from "./infrastructures/database.js";
import { createLogger } from "./infrastructures/logger.js";
import { createR2Signer } from "./infrastructures/r2-signer.js";
import { createRunnerClient } from "./infrastructures/runner-client.js";
import { createContestRepository } from "./repositories/contest-repository.js";
import { createSubmissionRepository } from "./repositories/submission-repository.js";
import { createAdminRepository } from "./repositories/admin-repository.js";
import { createAdminService } from "./services/admin-service.js";
import { createContestService } from "./services/contest-service.js";
import { createSubmissionQueryService } from "./services/submission-query-service.js";
import { createSubmissionService } from "./services/submission-service.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config);
const runner = await createRunnerClient(config);
const contestRepository = createContestRepository(database);
const submissionRepository = createSubmissionRepository(database);
const administrationRepository = createAdminRepository(database);
const app = createApp({
  config,
  database,
  logger,
  contest: createContestService(
    contestRepository,
    createR2Signer(config),
    config,
    runner,
  ),
  administration: createAdminService(
    administrationRepository,
    submissionRepository,
    config,
  ),
  submissions: createSubmissionService(submissionRepository, runner, config),
  submissionQueries: createSubmissionQueryService(
    submissionRepository,
    contestRepository,
  ),
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: config.PORT,
});
logger.info("1BRC APIを起動しました", {
  port: config.PORT,
  environmentId: config.BENCHMARK_ENVIRONMENT_ID,
});

async function shutdown(signal: string) {
  logger.info("1BRC APIを停止します", { signal });
  await server.stop(true);
  await database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
