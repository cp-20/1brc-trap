import { Hono } from "hono";
import type { AccountService } from "../services/account-service.js";
import type { RouterEnv } from "./router-context.js";
import { requireHeaderUser, resultResponse } from "./router-context.js";

export function createAccountRouter(service: AccountService) {
  return new Hono<RouterEnv>()
    .get("/me", (context) => context.json({ user: context.get("authUser") }))
    .post("/access-key", (context) =>
      resultResponse(
        context,
        requireHeaderUser(context).asyncAndThen((user) =>
          service.issueAccessKey(user.username),
        ),
        (issued) => context.json(issued, 201),
      ),
    )
    .delete("/access-key", (context) =>
      resultResponse(
        context,
        requireHeaderUser(context).asyncAndThen((user) =>
          service.revokeAccessKey(user.username),
        ),
        () => context.body(null, 204),
      ),
    );
}
