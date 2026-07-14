import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { RowDataPacket } from "mysql2";
import type { Config } from "../infrastructures/config.js";
import type { Database } from "../infrastructures/database.js";
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

type TokenRow = RowDataPacket & { username: string; token_hash: Buffer };

const usernamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export function authMiddleware(
  database: Database,
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
      const result = await database.query<TokenRow[]>(
        "SELECT username, token_hash FROM api_tokens WHERE token_hash = ? LIMIT 1",
        [digest],
      );
      if (result.isErr()) return errorResponse(context, result.error);
      if (
        result.value[0] &&
        timingSafeEqual(result.value[0].token_hash, digest)
      ) {
        const username = result.value[0].username;
        authUser = { username, isAdmin: false, method: "token" };
        void database.execute(
          "UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP(6) WHERE username = ? AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP(6) - INTERVAL 5 MINUTE)",
          [username],
        );
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
      const inserted = await database.execute(
        "INSERT IGNORE INTO users (username) VALUES (?)",
        [authUser.username],
      );
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
