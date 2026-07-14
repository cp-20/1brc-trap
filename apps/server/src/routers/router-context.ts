import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import type { AppVariables, AuthUser } from "../middlewares/auth.js";
import { AppError, errorStatus } from "../utils/errors.js";

export type RouterEnv = { Variables: AppVariables };
export type RouterContext = Context<RouterEnv>;

export function errorResponse(context: RouterContext, error: AppError) {
  return context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId: context.get("requestId"),
      },
    },
    errorStatus(error),
  );
}

export async function resultResponse<T, S>(
  context: RouterContext,
  result: Result<T, AppError> | PromiseLike<Result<T, AppError>>,
  success: (value: T) => S | Promise<S>,
): Promise<S | ReturnType<typeof errorResponse>> {
  const resolved = await result;
  return resolved.isErr()
    ? errorResponse(context, resolved.error)
    : success(resolved.value);
}

export function validationHook(result: { success: boolean }, context: Context) {
  if (!result.success) {
    return errorResponse(
      context as RouterContext,
      new AppError(
        "bad_request",
        "invalid_request",
        "リクエストの形式が不正です",
      ),
    );
  }
}

export function requireUser(
  context: RouterContext,
): Result<AuthUser, AppError> {
  const user = context.get("authUser");
  return user
    ? ok(user)
    : err(
        new AppError(
          "unauthorized",
          "authentication_required",
          "ログインまたはアクセスキーが必要です",
        ),
      );
}

export function requireHeaderUser(
  context: RouterContext,
): Result<AuthUser, AppError> {
  return requireUser(context).andThen((user) =>
    user.method === "header"
      ? ok(user)
      : err(
          new AppError(
            "forbidden",
            "browser_auth_required",
            "ブラウザからログインしてください",
          ),
        ),
  );
}

export function requireAdmin(
  context: RouterContext,
): Result<AuthUser, AppError> {
  return requireHeaderUser(context).andThen((user) =>
    user.isAdmin
      ? ok(user)
      : err(
          new AppError("forbidden", "admin_required", "管理者権限が必要です"),
        ),
  );
}
