import { benchmarkPolicy } from "@1brc/domain";

export function buildContainerCreateArgs(options: {
  container: string;
  workDirectory: string;
  artifact: string;
  containerArtifact: string;
  input: string;
  image: string;
  kind: string;
}) {
  return [
    "create",
    "--name",
    options.container,
    "--network",
    "none",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    String(benchmarkPolicy.pidLimit),
    "--mount",
    `type=bind,src=${options.workDirectory},dst=/work`,
    "--mount",
    `type=bind,src=${options.artifact},dst=${options.containerArtifact},readonly`,
    "--mount",
    `type=bind,src=${options.input},dst=/input/data.csv,readonly`,
    options.image,
    "/opt/bun/bin/bun",
    "/opt/1brc/measure.mjs",
    options.kind,
    options.containerArtifact,
    "/input/data.csv",
    "/work/output.txt",
    String(benchmarkPolicy.timeoutSeconds),
    String(benchmarkPolicy.stdioLimitBytes),
    String(benchmarkPolicy.outputLimitBytes),
  ];
}
