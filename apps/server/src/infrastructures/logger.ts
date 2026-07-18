export type LogLevel = "debug" | "info" | "warn" | "error";

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(minimum: LogLevel) {
  function write(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> = {},
  ) {
    if (weights[level] < weights[minimum]) return;
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`,
    );
  }
  return {
    debug: (message: string, fields?: Record<string, unknown>) =>
      write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) =>
      write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) =>
      write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) =>
      write("error", message, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return {
    name: error.name,
    message: error.message,
    ...(code ? { code } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause !== undefined && depth < 2
      ? { cause: serializeError(error.cause, depth + 1) }
      : {}),
  };
}
