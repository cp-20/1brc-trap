import { describe, expect, it, vi } from "bun:test";

import { Hono } from "hono";
import { errAsync, okAsync } from "neverthrow";

import type { ContestService } from "../services/contest-service.js";
import { AppError } from "../utils/errors.js";
import { createContestRouter } from "./contest-router.js";
import type { RouterEnv } from "./router-context.js";

describe("API error boundary", () => {
  it("validation errorも共通のerror bodyとrequest IDを返す", async () => {
    const leaderboard = vi.fn(() => okAsync({}));
    const app = testApp({ leaderboard });

    const response = await app.request("/leaderboard?board=unknown");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "リクエストの形式が不正です",
        requestId: "request-id",
      },
    });
    expect(leaderboard).not.toHaveBeenCalled();
  });

  it("serviceのResult errorをhandlerでHTTP responseへ変換する", async () => {
    const leaderboard = vi.fn(() =>
      errAsync(
        new AppError(
          "infrastructure",
          "database_error",
          "Database operation failed",
        ),
      ),
    );
    const app = testApp({ leaderboard });

    const response = await app.request("/leaderboard?board=public");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "database_error",
        message: "Database operation failed",
        requestId: "request-id",
      },
    });
  });
});

function testApp(service: { leaderboard: ReturnType<typeof vi.fn> }) {
  const app = new Hono<RouterEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-id");
    context.set("authUser", null);
    await next();
  });
  return app.route(
    "/",
    createContestRouter(service as unknown as ContestService),
  );
}
