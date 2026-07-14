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
