import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SubmissionService } from "../services/submission-service.js";
import type { SubmissionQueryService } from "../services/submission-query-service.js";
import { streamJsonChanges } from "../utils/sse.js";
import type { RouterEnv } from "./router-context.js";
import {
  errorResponse,
  requireUser,
  resultResponse,
} from "./router-context.js";

export function createSubmissionRouter(
  submissions: SubmissionService,
  query: SubmissionQueryService,
) {
  return new Hono<RouterEnv>()
    .post("/submissions", (context) =>
      resultResponse(
        context,
        requireUser(context).asyncAndThen((user) =>
          submissions.accept(user.username, context.req.raw),
        ),
        (reservation) => {
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
        },
      ),
    )
    .get("/submissions", (context) =>
      resultResponse(
        context,
        requireUser(context).asyncAndThen((user) =>
          query.listForUser(user.username),
        ),
        (rows) => context.json({ submissions: rows }),
      ),
    )
    .get("/submissions/events", (context) => {
      const user = requireUser(context);
      if (user.isErr()) return errorResponse(context, user.error);
      context.header("Cache-Control", "no-cache, no-transform");
      context.header("X-Accel-Buffering", "no");
      return streamSSE(context, (stream) =>
        streamJsonChanges(stream, {
          event: "submissions",
          load: () =>
            query
              .listForUser(user.value.username)
              .map((rows) => ({ submissions: rows })),
        }),
      );
    })
    .get("/submissions/:id", (context) =>
      resultResponse(
        context,
        requireUser(context).asyncAndThen((user) =>
          query.getForUser(context.req.param("id"), user),
        ),
        (submission) => context.json({ submission }),
      ),
    )
    .get("/submissions/:id/source", (context) =>
      resultResponse(
        context,
        query.readSource(context.req.param("id"), context.get("authUser")),
        (source) => {
          context.header("Content-Type", "text/plain; charset=utf-8");
          context.header(
            "Content-Disposition",
            `inline; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
          );
          context.header("X-Content-Type-Options", "nosniff");
          return context.body(new Uint8Array(source.content));
        },
      ),
    );
}
