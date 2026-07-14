import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const [
  kind,
  artifact,
  input,
  output,
  timeoutText,
  stdioLimitText,
  outputLimitText,
] = process.argv.slice(2);
const timeoutMs = Number(timeoutText) * 1000;
const stdioLimitBytes = Number(stdioLimitText);
const outputLimitBytes = Number(outputLimitText);
if (
  !Number.isFinite(timeoutMs) ||
  timeoutMs <= 0 ||
  !Number.isSafeInteger(stdioLimitBytes) ||
  stdioLimitBytes <= 0 ||
  !Number.isSafeInteger(outputLimitBytes) ||
  outputLimitBytes <= 0
) {
  throw new Error("invalid benchmark limits");
}
const commands = {
  native: [artifact, [input, output]],
  javascript: ["/opt/node/bin/node", [artifact, input, output]],
  typescript: ["/opt/node/bin/node", [artifact, input, output]],
  bun: ["/opt/bun/bin/bun", [artifact, input, output]],
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
let stderr = "";
let spawnError = null;
child.stdout.on("data", (chunk) => {
  captured += chunk.length;
  if (captured > stdioLimitBytes) {
    outputExceeded = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
});
child.stderr.on("data", (chunk) => {
  captured += chunk.length;
  stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
  if (captured > stdioLimitBytes) {
    outputExceeded = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
});
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
    if ((await stat(output)).size > outputLimitBytes) {
      outputExceeded = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  } catch {}
  checkingOutput = false;
}, 25);
const result = await new Promise((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
    resolve({ code: null, signal: null });
  });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
clearInterval(outputWatcher);
const durationNs = (process.hrtime.bigint() - start).toString();

let verdict = "accepted";
let error = null;
if (timedOut) verdict = "time_limit";
else if (outputExceeded) verdict = "output_limit";
else if (result.code !== 0) verdict = "runtime_error";
else {
  try {
    if ((await stat(output)).size > outputLimitBytes) verdict = "output_limit";
  } catch {
    verdict = "runtime_error";
    error = "出力ファイルが作成されませんでした";
  }
}
if (verdict === "runtime_error" && !error) {
  error =
    stderr.trim() || spawnError?.message || `process exited ${result.code}`;
}
if (verdict === "time_limit") error = "制限時間を超えました";
if (verdict === "output_limit") error = "出力サイズの上限を超えました";
process.stdout.write(
  JSON.stringify({
    verdict,
    durationNs: verdict === "accepted" ? durationNs : null,
    error,
  }),
);
