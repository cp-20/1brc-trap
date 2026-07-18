import process from "node:process";

const count = Number(process.argv[2] ?? 200);
const holdMs = Number(process.argv[3] ?? 2_000);
const submissionCount = Number(process.argv[4] ?? 50);
const controllers = Array.from({ length: count }, () => new AbortController());
const connections = await Promise.all(
  controllers.map(async (controller) => {
    const response = await fetch("http://127.0.0.1:39001/events", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    return {
      reader,
      pump: (async () => {
        let next = first;
        while (!next.done) next = await reader.read();
      })().catch(() => undefined),
    };
  }),
);
console.log(`connected=${connections.length}`);
const submissionRequests = Array.from({ length: submissionCount }, () => {
  const form = new FormData();
  form.set("executionKind", "typescript");
  const source = new Uint8Array(1024 * 1024);
  source.fill(120);
  form.set("source", new File([source], "main.ts"));
  return fetch("http://127.0.0.1:39001/submissions", {
    method: "POST",
    body: form,
  });
});
for (let attempt = 0; submissionCount > 0; attempt++) {
  const stats = (await fetch("http://127.0.0.1:39001/stats").then((response) =>
    response.json(),
  )) as { pendingUploads: number };
  if (stats.pendingUploads === submissionCount) break;
  if (attempt === 1_500) throw new Error("submissions did not become pending");
  await Bun.sleep(20);
}
console.log(`pendingSubmissions=${submissionCount}`);
await Bun.sleep(holdMs);
await fetch("http://127.0.0.1:39001/submissions/release", { method: "POST" });
await Promise.all(submissionRequests);
controllers.forEach((controller) => controller.abort());
await Promise.allSettled(connections.map(({ reader }) => reader.cancel()));
await Promise.allSettled(connections.map(({ pump }) => pump));
console.log("closed");
