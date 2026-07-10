import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const [kind, artifact, input, output, timeoutText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText) * 1000;
const commands = {
  native: [artifact, [input, output]],
  javascript: ["/opt/node/bin/node", [artifact, input, output]],
  typescript: ["/opt/node/bin/node", [artifact, input, output]],
  ruby: ["/opt/ruby/bin/ruby", [artifact, input, output]],
};
const selected = commands[kind];
if (!selected) {
  process.stdout.write(
    JSON.stringify({ verdict: "invalid_submission", durationNs: null }),
  );
  process.exit(0);
}

const start = process.hrtime.bigint();
const child = spawn(selected[0], selected[1], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let captured = 0;
let outputExceeded = false;
let timedOut = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    captured += chunk.length;
    if (captured > 1024 * 1024) {
      outputExceeded = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  });
}
const timer = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}, timeoutMs);
let checkingOutput = false;
const outputWatcher = setInterval(async () => {
  if (checkingOutput || outputExceeded) return;
  checkingOutput = true;
  try {
    if ((await stat(output)).size > 256 * 1024 * 1024) {
      outputExceeded = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  } catch {}
  checkingOutput = false;
}, 25);
const result = await new Promise((resolve) => {
  child.once("error", () => resolve({ code: null, signal: null }));
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
clearInterval(outputWatcher);
const durationNs = (process.hrtime.bigint() - start).toString();

let verdict = "accepted";
if (timedOut) verdict = "time_limit";
else if (outputExceeded) verdict = "output_limit";
else if (result.code !== 0) verdict = "runtime_error";
else {
  try {
    if ((await stat(output)).size > 256 * 1024 * 1024) verdict = "output_limit";
  } catch {
    verdict = "runtime_error";
  }
}
process.stdout.write(
  JSON.stringify({
    verdict,
    durationNs: verdict === "accepted" ? durationNs : null,
  }),
);
