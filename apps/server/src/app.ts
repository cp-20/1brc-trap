import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";

import type { Config } from "./infrastructures/config.js";
import type { Database } from "./infrastructures/database.js";
import type { Logger } from "./infrastructures/logger.js";
import { authMiddleware, type AppVariables } from "./middlewares/auth.js";
import type { AccountRepository } from "./repositories/account-repository.js";
import { createAccountRouter } from "./routers/account-router.js";
import { createAdminRouter } from "./routers/admin-router.js";
import { createContestRouter } from "./routers/contest-router.js";
import { errorResponse, type RouterEnv } from "./routers/router-context.js";
import { createSubmissionRouter } from "./routers/submission-router.js";
import type { AccountService } from "./services/account-service.js";
import type { AdminService } from "./services/admin-service.js";
import type { ContestService } from "./services/contest-service.js";
import type { SubmissionQueryService } from "./services/submission-query-service.js";
import type { SubmissionService } from "./services/submission-service.js";
import { AppError, errorStatus } from "./utils/errors.js";

export type AppDependencies = {
  config: Config;
  database: Database;
  authentication: AccountRepository;
  logger: Logger;
  contest: ContestService;
  account: AccountService;
  administration: AdminService;
  submissions: SubmissionService;
  submissionQueries: SubmissionQueryService;
};

export function createApiRoutes(dependencies: AppDependencies) {
  return new Hono<RouterEnv>()
    .get("/healthz", (context) => context.json({ ok: true }))
    .get("/readyz", async (context) => {
      const result = await dependencies.database.ping();
      return result.isOk()
        ? context.json({ ok: true })
        : context.json({ ok: false }, 503);
    })
    .route("/", createContestRouter(dependencies.contest))
    .route("/", createAccountRouter(dependencies.account))
    .route(
      "/",
      createSubmissionRouter(
        dependencies.submissions,
        dependencies.submissionQueries,
      ),
    )
    .route(
      "/",
      createAdminRouter(
        dependencies.administration,
        dependencies.submissionQueries,
      ),
    );
}

export type ApiType = ReturnType<typeof createApiRoutes>;

export function createApp(dependencies: AppDependencies) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set(
      "requestId",
      context.req.header("x-request-id") ?? randomUUID(),
    );
    await next();
    context.header("X-Request-Id", context.get("requestId"));
  });
  app.use("*", secureHeaders());
  app.use(
    "/api/*",
    authMiddleware(dependencies.authentication, dependencies.config),
  );
  app.use("/api/*", async (context, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(context.req.method) &&
      context.get("authUser")?.method === "header"
    ) {
      if (context.req.header("origin") !== dependencies.config.APP_ORIGIN) {
        return errorResponse(
          context,
          new AppError("forbidden", "invalid_origin", "Originが一致しません"),
        );
      }
    }
    await next();
  });
  app.route("/api/v1", createApiRoutes(dependencies));
  app.notFound(async (context) => {
    if (context.req.path.startsWith("/api/")) {
      return context.json(
        {
          error: {
            code: "not_found",
            message: "Not found",
            requestId: context.get("requestId"),
          },
        },
        404,
      );
    }
    const response = await serveStatic({
      root: dependencies.config.STATIC_ROOT,
      path: "index.html",
    })(context, async () => undefined);
    return response ?? context.text("Frontend is not built", 404);
  });
  app.use("/*", serveStatic({ root: dependencies.config.STATIC_ROOT }));
  app.onError((error, context) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            "infrastructure",
            "internal_error",
            "Internal server error",
            error,
          );
    dependencies.logger.error("request failed", {
      requestId: context.get("requestId"),
      code: appError.code,
      error: error instanceof Error ? error.stack : String(error),
    });
    return context.json(
      {
        error: {
          code: appError.code,
          message: appError.message,
          requestId: context.get("requestId"),
        },
      },
      errorStatus(appError),
    );
  });
  return app;
}
