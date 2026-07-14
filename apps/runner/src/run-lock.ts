import { spawn } from "node:child_process";

export async function runWithFileLock(
  lockFile: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | "busy"> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "flock",
      ["--nonblock", "--conflict-exit-code", "75", lockFile, command, ...args],
      { stdio: "inherit", env },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return exitCode === 75 ? "busy" : exitCode;
}
