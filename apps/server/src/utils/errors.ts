export type AppErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "contest_closed"
  | "infrastructure";

export class AppError extends Error {
  constructor(
    readonly kind: AppErrorKind,
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorStatus(
  error: AppError,
): 400 | 401 | 403 | 404 | 409 | 500 {
  switch (error.kind) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "contest_closed":
      return 409;
    case "infrastructure":
      return 500;
  }
}
