import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    "data-dir": { type: "string", default: "data/runner" },
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

const dataDirectory = resolvePath(values["data-dir"]);
const datasetFiles = [
  "public.csv",
  "public.expected",
  "private.csv",
  "private.expected",
] as const;
const checksums = Object.fromEntries(
  await Promise.all(
    datasetFiles.map(async (filename) => [
      filename,
      await sha256(`${dataDirectory}/${filename}`),
    ]),
  ),
);

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
`,
  ),
  writeFile(
    groupVarsPath,
    `onebrc_runner_public_key: ${yamlString(runnerPublicKey)}
onebrc_environment_id: ${yamlString(stack.BenchmarkEnvironment)}
onebrc_runner_image: ${yamlString(values["runner-image"])}
onebrc_data_source: ${yamlString(dataDirectory)}
onebrc_public_input: "/var/lib/1brc/data/public.csv"
onebrc_public_expected: "/var/lib/1brc/data/public.expected"
onebrc_private_input: "/var/lib/1brc/data/private.csv"
onebrc_private_expected: "/var/lib/1brc/data/private.expected"
onebrc_expected_checksums:
${datasetFiles.map((filename) => `  ${filename}: ${yamlString(checksums[filename])}`).join("\n")}
`,
  ),
]);

process.stdout.write(`Wrote ${inventoryPath}\nWrote ${groupVarsPath}\n`);

function resolvePath(path: string): string {
  return resolve(
    path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path,
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
