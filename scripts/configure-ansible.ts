import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "cdk-outputs": {
      type: "string",
      default: "infra/cdk/cdk-outputs.json",
    },
    "ssh-private-key": { type: "string" },
    "runner-public-key": { type: "string" },
    "runner-downloads": {
      type: "string",
      default: "data/contest/runner-downloads.json",
    },
    inventory: { type: "string", default: "infra/ansible/inventory.yml" },
    "group-vars": {
      type: "string",
      default: "infra/ansible/group_vars/all.yml",
    },
    "runner-image": {
      type: "string",
      default: "onebrc-runner:ubuntu26-v1",
    },
  },
  strict: true,
});

if (!values["ssh-private-key"] || !values["runner-public-key"]) {
  throw new Error("--ssh-private-key and --runner-public-key are required");
}

type CdkStackOutputs = {
  BenchmarkPublicIp?: string;
  BenchmarkEnvironment?: string;
};

const datasetFiles = [
  "public.csv",
  "public.expected",
  "private.csv",
  "private.expected",
] as const;
type DatasetFile = (typeof datasetFiles)[number];
type Download = {
  url: string;
  sha256: string;
  compressedSha256: string;
};
type RunnerDownloads = {
  expiresAt?: string;
  files?: Partial<Record<DatasetFile, Partial<Download>>>;
};

const outputs = JSON.parse(
  await readFile(resolvePath(values["cdk-outputs"]), "utf8"),
) as Record<string, CdkStackOutputs>;
const stack = Object.values(outputs).find(
  (candidate) => candidate.BenchmarkPublicIp && candidate.BenchmarkEnvironment,
);
if (!stack?.BenchmarkPublicIp || !stack.BenchmarkEnvironment) {
  throw new Error(
    "CDK outputs do not contain BenchmarkPublicIp and BenchmarkEnvironment",
  );
}

const runnerPublicKey = (
  await readFile(resolvePath(values["runner-public-key"]), "utf8")
).trim();
if (!runnerPublicKey.startsWith("ssh-")) {
  throw new Error("runner public key is not an OpenSSH public key");
}

const runnerDownloads = JSON.parse(
  await readFile(resolvePath(values["runner-downloads"]), "utf8"),
) as RunnerDownloads;
const expiresAt = Date.parse(runnerDownloads.expiresAt ?? "");
if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
  throw new Error("runner download URLs are expired; run presign-runner again");
}
const downloads = {} as Record<DatasetFile, Download>;
for (const filename of datasetFiles) {
  const download = runnerDownloads.files?.[filename];
  if (
    !download?.url?.startsWith("https://") ||
    !download.sha256?.match(/^[0-9a-f]{64}$/) ||
    !download.compressedSha256?.match(/^[0-9a-f]{64}$/)
  ) {
    throw new Error(`invalid runner download: ${filename}`);
  }
  downloads[filename] = download as Download;
}

const inventoryPath = resolvePath(values.inventory);
const groupVarsPath = resolvePath(values["group-vars"]);
await Promise.all([
  mkdir(dirname(inventoryPath), { recursive: true }),
  mkdir(dirname(groupVarsPath), { recursive: true }),
]);
await Promise.all([
  writeFile(
    inventoryPath,
    `all:
  hosts:
    benchmark:
      ansible_host: ${yamlString(stack.BenchmarkPublicIp)}
      ansible_user: ubuntu
      ansible_ssh_private_key_file: ${yamlString(resolvePath(values["ssh-private-key"]))}
      ansible_ssh_common_args: "-o StrictHostKeyChecking=accept-new"
`,
  ),
  writeFile(
    groupVarsPath,
    `onebrc_runner_public_key: ${yamlString(runnerPublicKey)}
onebrc_environment_id: ${yamlString(stack.BenchmarkEnvironment)}
onebrc_runner_image: ${yamlString(values["runner-image"])}
onebrc_public_input: "/var/lib/1brc/data/public.csv"
onebrc_public_expected: "/var/lib/1brc/data/public.expected"
onebrc_private_input: "/var/lib/1brc/data/private.csv"
onebrc_private_expected: "/var/lib/1brc/data/private.expected"
onebrc_dataset_downloads:
${datasetFiles
  .map(
    (filename) => `  ${filename}:
    url: ${yamlString(downloads[filename].url)}
    sha256: ${yamlString(downloads[filename].sha256)}
    compressed_sha256: ${yamlString(downloads[filename].compressedSha256)}`,
  )
  .join("\n")}
`,
    { mode: 0o600 },
  ),
]);
await chmod(groupVarsPath, 0o600);

process.stdout.write(
  `Wrote ${inventoryPath}\nWrote ${groupVarsPath} (URLs expire at ${runnerDownloads.expiresAt})\n`,
);

function resolvePath(path: string): string {
  return resolve(
    path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path,
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
