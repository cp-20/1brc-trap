import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

describe("baselines/ts/main.ts", () => {
  it("accepts input and output as two positional arguments", async () => {
    const directory = await mkdtemp(`${tmpdir()}/onebrc-ts-baseline-`);
    const input = resolve(directory, "input.csv");
    const output = resolve(directory, "output.txt");
    try {
      await writeFile(
        input,
        `unix_timestamp,channel_path,message_length,stamp_count
1798761600,team/dev,10,1
1798761660,team/dev,20,2
`,
      );
      await execute("node", [
        "--experimental-strip-types",
        resolve(process.cwd(), "../../baselines/ts/main.ts"),
        input,
        output,
      ]);
      expect(await readFile(output, "utf8")).toBe(
        "team/dev,2027-01=10/15.00/20/2/3\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
