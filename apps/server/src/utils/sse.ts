import type { SSEStreamingApi } from "hono/streaming";

export async function streamJsonChanges<T>(
  stream: SSEStreamingApi,
  options: {
    event: string;
    load: () => Promise<T>;
    intervalMs?: number;
    heartbeatMs?: number;
  },
) {
  const intervalMs = options.intervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let previous = "";
  let lastWriteAt = Date.now();

  while (!stream.closed && !stream.aborted) {
    const data = JSON.stringify(await options.load());
    if (data !== previous) {
      previous = data;
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
