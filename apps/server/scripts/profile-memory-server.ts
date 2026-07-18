import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { okAsync, ResultAsync } from "neverthrow";

import type { Config } from "../src/infrastructures/config.js";
import type { RunnerClient } from "../src/infrastructures/runner-client.js";
import type { SubmissionRepository } from "../src/repositories/submission-repository.js";
import { createSubmissionService } from "../src/services/submission-service.js";
import { streamJsonChanges } from "../src/utils/sse.js";

const error = "x".repeat(Number(process.env.ERROR_BYTES ?? 8_192));
const rows = Array.from(
  { length: Number(process.env.ROWS ?? 100) },
  (_, i) => ({
    id: crypto.randomUUID(),
    username: `user-${i}`,
    status: "completed",
    sourceFilename: "main.ts",
    public: { verdict: "accepted", scoreNs: i * 1_000_000 },
    error,
  }),
);

let pendingUploads = 0;
let releaseUploads = () => {};
let uploadGate = resetUploadGate();
const submissions = createSubmissionService(
  {
    reserve: () =>
      okAsync({
        id: crypto.randomUUID(),
        uploadStartedAt: new Date().toISOString(),
      }),
    storeSource: () => okAsync(undefined),
    queueUpload: () => okAsync(undefined),
    discardUpload: () => okAsync(undefined),
  } as unknown as SubmissionRepository,
  {
    upload: () => {
      pendingUploads++;
      return ResultAsync.fromSafePromise(
        uploadGate.finally(() => pendingUploads--),
      );
    },
    cleanup: () => okAsync(undefined),
  } as unknown as RunnerClient,
  {} as Config,
);

const app = new Hono()
  .get("/events", (context) =>
    streamSSE(context, (stream) =>
      streamJsonChanges(stream, {
        event: "submissions",
        cacheKey: "profile:submissions",
        load: () => okAsync({ submissions: rows }),
        intervalMs: 20,
        heartbeatMs: Infinity,
      }),
    ),
  )
  .post("/submissions", async (context) => {
    const result = await submissions.accept("profile", context.req.raw);
    return result.match(
      () => context.json({ ok: true }),
      (uploadError) =>
        context.json({ ok: false, error: uploadError.message }, 400),
    );
  })
  .post("/submissions/release", (context) => {
    releaseUploads();
    uploadGate = resetUploadGate();
    return context.json({ ok: true });
  })
  .get("/stats", (context) => {
    Bun.gc(true);
    return context.json({
      memory: process.memoryUsage(),
      pendingUploads,
    });
  })
  .get("/snapshot/:name", async (context) => {
    Bun.gc(true);
    const snapshot = Bun.generateHeapSnapshot("v8", "arraybuffer");
    const path = `/tmp/${context.req.param("name")}-${Bun.version}.heapsnapshot`;
    await Bun.write(path, snapshot);
    return context.json({
      path,
      bytes: snapshot.byteLength,
      memory: process.memoryUsage(),
    });
  });

const server = Bun.serve({ port: 39_001, idleTimeout: 30, fetch: app.fetch });
console.log(
  JSON.stringify({ bun: Bun.version, pid: process.pid, url: server.url }),
);

function resetUploadGate() {
  return new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });
}
