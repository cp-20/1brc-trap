import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runWithFileLock } from "./run-lock.js";

describe("runner file lock", () => {
  it("同時実行を拒否し、計測プロセスが異常終了しても同じlock fileを再利用できる", async () => {
    const directory = await mkdtemp(join(tmpdir(), "1brc-run-lock-"));
    const lockFile = join(directory, "run.lock");
    const acquiredMarker = join(directory, "acquired");
    try {
      const first = runWithFileLock(lockFile, process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(acquiredMarker)}, ""); setTimeout(() => process.kill(process.pid, "SIGKILL"), 200)`,
      ]);
      await waitForFile(acquiredMarker);

      await expect(
        runWithFileLock(lockFile, process.execPath, ["-e", ""]),
      ).resolves.toBe("busy");
      const crashResult = await first;
      expect(crashResult).not.toBe(0);
      expect(crashResult).not.toBe("busy");
      await expect(
        runWithFileLock(lockFile, process.execPath, ["-e", ""]),
      ).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("lock holder did not start");
}
