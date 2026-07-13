import { Hono } from "hono";
import type { AdminService } from "../services/admin-service.js";
import type { RouterEnv } from "./router-context.js";
import { requireHeaderUser } from "./router-context.js";

export function createAccountRouter(service: AdminService) {
  return new Hono<RouterEnv>()
    .get("/me", (context) => context.json({ user: context.get("authUser") }))
    .post("/access-key", async (context) => {
      const user = requireHeaderUser(context);
      return context.json(await service.issueAccessKey(user.username), 201);
    })
    .delete("/access-key", async (context) => {
      await service.revokeAccessKey(requireHeaderUser(context).username);
      return context.body(null, 204);
    });
}
