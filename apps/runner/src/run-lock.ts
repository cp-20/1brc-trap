import { execa } from "execa";

export async function runWithFileLock(
  lockFile: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | "busy"> {
  const { exitCode } = await execa(
    "flock",
    ["--nonblock", "--conflict-exit-code", "75", lockFile, command, ...args],
    {
      stdio: "inherit",
      env: env as Record<string, string>,
      reject: false,
    },
  );
  return exitCode === 75 ? "busy" : (exitCode ?? 1);
}

export async function waitForFileLock(
  lockFile: string,
  timeoutMs: number,
  whileBusy: () => Promise<void>,
) {
  const deadline = Date.now() + timeoutMs;
  while ((await runWithFileLock(lockFile, "true", [])) === "busy") {
    await whileBusy();
    if (Date.now() >= deadline)
      throw new Error("runner cancellation timed out");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}
