import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ContestService } from "../services/contest-service.js";
import { streamJsonChanges } from "../utils/sse.js";
import type { RouterEnv } from "./router-context.js";

const leaderboardQuerySchema = z.object({
  board: z.enum(["public", "private"]).optional(),
  language: z.string().optional(),
});

export function createContestRouter(service: ContestService) {
  return new Hono<RouterEnv>()
    .get("/contest", async (context) => context.json(await service.overview()))
    .get(
      "/contest/events",
      zValidator("query", leaderboardQuerySchema),
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
      zValidator("query", leaderboardQuerySchema),
      async (context) => {
        const query = context.req.valid("query");
        return context.json(
          await service.leaderboard(query.board, query.language),
        );
      },
    )
    .get("/datasets", async (context) =>
      context.json({ datasets: await service.publicDatasets() }),
    )
    .get("/datasets/:datasetId/:artifact/download", async (context) => {
      const url = await service.signedDatasetDownload(
        context.req.param("datasetId"),
        context.req.param("artifact"),
      );
      context.header("Cache-Control", "no-store");
      return context.redirect(url, 302);
    });
}
