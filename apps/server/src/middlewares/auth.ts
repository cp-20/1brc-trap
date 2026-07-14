import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../infrastructures/config.js";
import type { AccountRepository } from "../repositories/account-repository.js";
import { errorResponse } from "../routers/router-context.js";
import { sha256 } from "../utils/crypto.js";

export type AuthUser = {
  username: string;
  isAdmin: boolean;
  method: "header" | "token";
};

export type AppVariables = {
  authUser: AuthUser | null;
  requestId: string;
};

const usernamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export function authMiddleware(
  accounts: AccountRepository,
  config: Config,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    let authUser: AuthUser | null = null;

    if (
      authorization?.startsWith("Bearer 1brc_") &&
      tokenMayAuthenticate(context.req.method, context.req.path)
    ) {
      const token = authorization.slice("Bearer ".length);
      const digest = sha256(token);
      const result = await accounts.token(digest);
      if (result.isErr()) return errorResponse(context, result.error);
      if (result.value && timingSafeEqual(result.value.token_hash, digest)) {
        const username = result.value.username;
        authUser = { username, isAdmin: false, method: "token" };
        void accounts.touchToken(username);
      }
    } else if (config.trustProxyHeader) {
      const forwarded = context.req.header("x-forwarded-user");
      if (forwarded && usernamePattern.test(forwarded)) {
        authUser = {
          username: forwarded,
          isAdmin: config.admins.has(forwarded),
          method: "header",
        };
      }
    }

    if (authUser) {
      const inserted = await accounts.ensureUser(authUser.username);
      if (inserted.isErr()) return errorResponse(context, inserted.error);
    }
    context.set("authUser", authUser);
    await next();
  };
}

function tokenMayAuthenticate(method: string, path: string) {
  if (path === "/api/v1/submissions")
    return method === "GET" || method === "POST";
  return (
    method === "GET" && /^\/api\/v1\/submissions\/[0-9a-f-]{36}$/i.test(path)
  );
}
