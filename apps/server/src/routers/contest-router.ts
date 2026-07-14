import { languageSchema, leaderboardBoardSchema } from "@1brc/domain";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import type { ContestService } from "../services/contest-service.js";
import { streamJsonChanges } from "../utils/sse.js";
import type { RouterEnv } from "./router-context.js";
import { resultResponse, validationHook } from "./router-context.js";

const leaderboardQuerySchema = z.object({
  board: leaderboardBoardSchema.optional(),
  language: languageSchema.optional(),
});

export function createContestRouter(service: ContestService) {
  return new Hono<RouterEnv>()
    .get("/contest", (context) =>
      resultResponse(context, service.overview(), (contest) =>
        context.json(contest),
      ),
    )
    .get(
      "/contest/events",
      zValidator("query", leaderboardQuerySchema, validationHook),
      (context) => {
        const query = context.req.valid("query");
        context.header("Cache-Control", "no-cache, no-transform");
        context.header("X-Accel-Buffering", "no");
        return streamSSE(context, (stream) =>
          streamJsonChanges(stream, {
            event: "contest",
            load: () => service.liveSnapshot(query.board, query.language),
          }),
        );
      },
    )
    .get(
      "/leaderboard",
      zValidator("query", leaderboardQuerySchema, validationHook),
      (context) => {
        const query = context.req.valid("query");
        return resultResponse(
          context,
          service.leaderboard(query.board, query.language),
          (leaderboard) => context.json(leaderboard),
        );
      },
    )
    .get("/datasets", (context) =>
      resultResponse(context, service.publicDatasets(), (datasets) =>
        context.json({ datasets }),
      ),
    )
    .get("/datasets/:datasetId/:artifact/download", (context) =>
      resultResponse(
        context,
        service.signedDatasetDownload(
          context.req.param("datasetId"),
          context.req.param("artifact"),
        ),
        (url) => {
          context.header("Cache-Control", "no-store");
          return context.redirect(url, 302);
        },
      ),
    );
}
