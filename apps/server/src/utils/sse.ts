import { createHash } from "node:crypto";

import type { SSEStreamingApi } from "hono/streaming";
import type { ResultAsync } from "neverthrow";

import type { AppError } from "./errors.js";
import { createResultCache } from "./result-cache.js";

const serializedCache = createResultCache<
  { data: string; digest: string },
  AppError
>(1_000);

export async function streamJsonChanges<T>(
  stream: SSEStreamingApi,
  options: {
    event: string;
    load: () => ResultAsync<T, AppError>;
    cacheKey?: string;
    intervalMs?: number;
    heartbeatMs?: number;
  },
) {
  const intervalMs = options.intervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let previousDigest = "";
  let lastWriteAt = Date.now();

  while (!stream.closed && !stream.aborted) {
    const loaded = await (options.cacheKey
      ? serializedCache(options.cacheKey, () =>
          options.load().map((value) => serialize(value)),
        )
      : options.load().map((value) => serialize(value)));
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
    const { data, digest } = loaded.value;
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

function serialize(value: unknown) {
  const data = JSON.stringify(value);
  return {
    data,
    digest: createHash("sha256").update(data).digest("base64"),
  };
}
