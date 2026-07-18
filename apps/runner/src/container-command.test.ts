import { describe, expect, it } from "bun:test";

import { benchmarkPolicy } from "@1brc/domain";

import { buildContainerCreateArgs } from "./container-command.js";

describe("benchmark container policy", () => {
  it("提出コードをnetwork・権限なし・read-only・共有上限値で実行する", () => {
    const args = buildContainerCreateArgs({
      container: "container",
      workDirectory: "/work/job",
      artifact: "/jobs/id/artifact",
      containerArtifact: "/submission/artifact",
      input: "/ram-data/public.csv",
      image: "runner-image",
      kind: "native",
    });

    expect(valueAfter(args, "--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(valueAfter(args, "--cap-drop")).toBe("ALL");
    expect(valueAfter(args, "--security-opt")).toBe("no-new-privileges=true");
    expect(valueAfter(args, "--pids-limit")).toBe(
      String(benchmarkPolicy.pidLimit),
    );
    expect(args.slice(-3)).toEqual([
      String(benchmarkPolicy.timeoutSeconds),
      String(benchmarkPolicy.stdioLimitBytes),
      String(benchmarkPolicy.outputLimitBytes),
    ]);
  });
});

function valueAfter(values: string[], option: string) {
  return values[values.indexOf(option) + 1];
}
