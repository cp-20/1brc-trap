import type { Context } from "hono";
import type { AppVariables, AuthUser } from "../middlewares/auth.js";
import { AppError } from "../utils/errors.js";

export type RouterEnv = { Variables: AppVariables };
export type RouterContext = Context<RouterEnv>;

export function requireUser(context: RouterContext): AuthUser {
  const user = context.get("authUser");
  if (!user) {
    throw new AppError(
      "unauthorized",
      "authentication_required",
      "ログインまたはアクセスキーが必要です",
    );
  }
  return user;
}

export function requireHeaderUser(context: RouterContext): AuthUser {
  const user = requireUser(context);
  if (user.method !== "header") {
    throw new AppError(
      "forbidden",
      "browser_auth_required",
      "ブラウザからログインしてください",
    );
  }
  return user;
}

export function requireAdmin(context: RouterContext): AuthUser {
  const user = requireHeaderUser(context);
  if (!user.isAdmin)
    throw new AppError("forbidden", "admin_required", "管理者権限が必要です");
  return user;
}
