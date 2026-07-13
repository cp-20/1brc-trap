import { datasetManifestSchema } from "@1brc/contracts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminService } from "../services/admin-service.js";
import type { SubmissionQueryService } from "../services/submission-query-service.js";
import type { RouterEnv } from "./router-context.js";
import { requireAdmin } from "./router-context.js";

export function createAdminRouter(
  administration: AdminService,
  submissions: SubmissionQueryService,
) {
  return new Hono<RouterEnv>()
    .get("/admin/submissions", async (context) => {
      requireAdmin(context);
      return context.json({ submissions: await submissions.listForAdmin() });
    })
    .post("/admin/submissions/:id/retry", async (context) => {
      const admin = requireAdmin(context);
      await administration.retrySubmission(
        admin.username,
        context.req.param("id"),
      );
      return context.json({ ok: true });
    })
    .post(
      "/admin/submissions/:id/disqualify",
      zValidator("json", z.object({ reason: z.string().trim().min(1) })),
      async (context) => {
        const admin = requireAdmin(context);
        await administration.disqualifySubmission(
          admin.username,
          context.req.param("id"),
          context.req.valid("json").reason,
        );
        return context.json({ ok: true });
      },
    )
    .post(
      "/admin/datasets/import",
      zValidator("json", datasetManifestSchema),
      async (context) => {
        const admin = requireAdmin(context);
        const imported = await administration.importDatasetManifest(
          admin.username,
          context.req.valid("json"),
        );
        return context.json({ imported });
      },
    )
    .post("/admin/private/publish", async (context) => {
      const admin = requireAdmin(context);
      await administration.publishPrivateResults(admin.username);
      return context.json({ published: true });
    })
    .post("/admin/private/unpublish", async (context) => {
      const admin = requireAdmin(context);
      await administration.unpublishPrivateResults(admin.username);
      return context.json({ published: false });
    });
}
