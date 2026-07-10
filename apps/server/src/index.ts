import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { createR2Signer } from "./r2.js";
import { createRunnerClient } from "./runner-client.js";
import { createSubmissionService } from "./submission-service.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config);
const runner = await createRunnerClient(config);
const app = createApp({
  config,
  database,
  logger,
  signer: createR2Signer(config),
  submissions: createSubmissionService(database, runner, config),
});

const server = serve({ fetch: app.fetch, port: config.PORT });
logger.info("1BRC API started", {
  port: config.PORT,
  environmentId: config.BENCHMARK_ENVIRONMENT_ID,
});

async function shutdown(signal: string) {
  logger.info("shutting down", { signal });
  server.close();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
