import { expect, test } from "bun:test";

const entrypoint = `${import.meta.dir}/app-entrypoint`;

async function run(env: Record<string, string>) {
  const process = Bun.spawn(["/bin/sh", entrypoint, "/bin/echo", "app.js"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
  };
}

test("secretをInspectorのURL prefixに設定する", async () => {
  const result = await run({ PROFILING_SECRET: "a".repeat(32) });
  expect(result).toEqual({
    exitCode: 0,
    stdout: `--inspect=0.0.0.0:6499/${"a".repeat(32)} app.js\n`,
  });
});

test("短いsecretを拒否する", async () => {
  expect((await run({ PROFILING_SECRET: "too-short" })).exitCode).toBe(1);
});
