import { datasetManifestSchema } from "@1brc/domain";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { AdminService } from "../services/admin-service.js";
import type { SubmissionQueryService } from "../services/submission-query-service.js";
import type { RouterEnv } from "./router-context.js";
import {
  requireAdmin,
  resultResponse,
  validationHook,
} from "./router-context.js";

export function createAdminRouter(
  administration: AdminService,
  submissions: SubmissionQueryService,
) {
  return new Hono<RouterEnv>()
    .get("/admin/submissions", (context) =>
      resultResponse(
        context,
        requireAdmin(context).asyncAndThen(() => submissions.listForAdmin()),
        (rows) => context.json({ submissions: rows }),
      ),
    )
    .post("/admin/submissions/:id/retry", (context) =>
      resultResponse(
        context,
        requireAdmin(context).asyncAndThen((admin) =>
          administration.retrySubmission(
            admin.username,
            context.req.param("id"),
          ),
        ),
        () => context.json({ ok: true }),
      ),
    )
    .post(
      "/admin/submissions/:id/disqualify",
      zValidator(
        "json",
        z.object({ reason: z.string().trim().min(1) }),
        validationHook,
      ),
      (context) =>
        resultResponse(
          context,
          requireAdmin(context).asyncAndThen((admin) =>
            administration.disqualifySubmission(
              admin.username,
              context.req.param("id"),
              context.req.valid("json").reason,
            ),
          ),
          () => context.json({ ok: true }),
        ),
    )
    .post(
      "/admin/datasets/import",
      zValidator("json", datasetManifestSchema, validationHook),
      (context) =>
        resultResponse(
          context,
          requireAdmin(context).asyncAndThen((admin) =>
            administration.importDatasetManifest(
              admin.username,
              context.req.valid("json"),
            ),
          ),
          (imported) => context.json({ imported }),
        ),
    )
    .post("/admin/private/publish", (context) =>
      resultResponse(
        context,
        requireAdmin(context).asyncAndThen((admin) =>
          administration.publishPrivateResults(admin.username),
        ),
        () => context.json({ published: true }),
      ),
    )
    .post("/admin/private/unpublish", (context) =>
      resultResponse(
        context,
        requireAdmin(context).asyncAndThen((admin) =>
          administration.unpublishPrivateResults(admin.username),
        ),
        () => context.json({ published: false }),
      ),
    );
}
