import { createHash } from "node:crypto";

import type { SSEStreamingApi } from "hono/streaming";
import type { ResultAsync } from "neverthrow";

import type { AppError } from "./errors.js";

export async function streamJsonChanges<T>(
  stream: SSEStreamingApi,
  options: {
    event: string;
    load: () => ResultAsync<T, AppError>;
    intervalMs?: number;
    heartbeatMs?: number;
  },
) {
  const intervalMs = options.intervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let previousDigest = "";
  let lastWriteAt = Date.now();

  while (!stream.closed && !stream.aborted) {
    const loaded = await options.load();
    if (loaded.isErr()) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          error: {
            code: loaded.error.code,
            message: loaded.error.message,
          },
        }),
      });
      return;
    }
    const data = JSON.stringify(loaded.value);
    const digest = createHash("sha256").update(data).digest("base64");
    if (digest !== previousDigest) {
      previousDigest = digest;
      lastWriteAt = Date.now();
      await stream.writeSSE({
        event: options.event,
        data,
        id: String(lastWriteAt),
        retry: 2_000,
      });
    } else if (Date.now() - lastWriteAt >= heartbeatMs) {
      lastWriteAt = Date.now();
      await stream.writeSSE({ event: "heartbeat", data: "{}" });
    }
    await stream.sleep(intervalMs);
  }
}
