import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SubmissionService } from "../services/submission-service.js";
import type { SubmissionQueryService } from "../services/submission-query-service.js";
import { streamJsonChanges } from "../utils/sse.js";
import type { RouterEnv } from "./router-context.js";
import { requireUser } from "./router-context.js";

export function createSubmissionRouter(
  submissions: SubmissionService,
  query: SubmissionQueryService,
) {
  return new Hono<RouterEnv>()
    .post("/submissions", async (context) => {
      const reservation = await submissions.accept(
        requireUser(context).username,
        context.req.raw,
      );
      context.header("Location", `/api/v1/submissions/${reservation.id}`);
      return context.json(
        {
          id: reservation.id,
          status: "queued" as const,
          statusUrl: `/api/v1/submissions/${reservation.id}`,
          uploadStartedAt: reservation.uploadStartedAt,
        },
        202,
      );
    })
    .get("/submissions", async (context) =>
      context.json({
        submissions: await query.listForUser(requireUser(context).username),
      }),
    )
    .get("/submissions/events", (context) => {
      const username = requireUser(context).username;
      context.header("Cache-Control", "no-cache, no-transform");
      context.header("X-Accel-Buffering", "no");
      return streamSSE(context, (stream) =>
        streamJsonChanges(stream, {
          event: "submissions",
          load: async () => ({
            submissions: await query.listForUser(username),
          }),
        }),
      );
    })
    .get("/submissions/:id", async (context) =>
      context.json({
        submission: await query.getForUser(
          context.req.param("id"),
          requireUser(context),
        ),
      }),
    )
    .get("/submissions/:id/source", async (context) => {
      const source = await query.readSource(
        context.req.param("id"),
        context.get("authUser"),
      );
      context.header("Content-Type", "text/plain; charset=utf-8");
      context.header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
      );
      context.header("X-Content-Type-Options", "nosniff");
      return context.body(new Uint8Array(source.content));
    });
}
