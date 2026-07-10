import * as fs from "node:fs";
import * as readline from "node:readline";

type ChannelStats = {
  minLen: number;
  maxLen: number;
  totalLen: number;
  messages: number;
  stamps: number;
};

type Options = {
  input: string;
  output: string;
};

const monthStartUnix = [
  1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000,
  1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600,
];

const monthLabels = [
  "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
  "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
];

function resultKey(unixTimestamp: string, channelPath: string): string {
  const timestamp = Number.parseInt(unixTimestamp, 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid unix_timestamp: ${unixTimestamp}`);
  }
  return `${channelPath},${monthLabelFromUnixTimestamp(timestamp)}`;
}

function monthLabelFromUnixTimestamp(timestamp: number): string {
  for (let i = monthLabels.length - 1; i >= 0; i--) {
    if (timestamp >= monthStartUnix[i] && timestamp < monthStartUnix[i + 1]) {
      return monthLabels[i];
    }
  }
  throw new Error(`unix_timestamp out of 2027 range: ${timestamp}`);
}

function parseArgs(args: string[]): Options {
  const options: Options = { input: "", output: "" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i" && i + 1 < args.length) {
      options.input = args[++i];
    } else if (args[i] === "-o" && i + 1 < args.length) {
      options.output = args[++i];
    } else {
      throw new Error(`unknown or incomplete argument: ${args[i]}`);
    }
  }
  return options;
}

async function analyze(input: NodeJS.ReadableStream): Promise<Map<string, ChannelStats>> {
  const stats = new Map<string, ChannelStats>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (lineNumber === 1) {
      const header = line.split(",");
      if (header.length !== 4) {
        throw new Error(`invalid header: expected 4 columns, got ${header.length}`);
      }
      continue;
    }
    if (line.length === 0) {
      continue;
    }

    const record = line.split(",");
    if (record.length !== 4) {
      throw new Error(`invalid line ${lineNumber}: expected 4 columns, got ${record.length}`);
    }

    const key = resultKey(record[0], record[1]);
    const messageLength = Number.parseInt(record[2], 10);
    const stampCount = Number.parseInt(record[3], 10);
    if (!Number.isFinite(messageLength)) {
      throw new Error(`invalid message_length on line ${lineNumber}`);
    }
    if (!Number.isFinite(stampCount)) {
      throw new Error(`invalid stamp_count on line ${lineNumber}`);
    }

    const existing = stats.get(key);
    if (existing === undefined) {
      stats.set(key, {
        minLen: messageLength,
        maxLen: messageLength,
        totalLen: messageLength,
        messages: 1,
        stamps: stampCount,
      });
    } else {
      if (messageLength < existing.minLen) existing.minLen = messageLength;
      if (messageLength > existing.maxLen) existing.maxLen = messageLength;
      existing.totalLen += messageLength;
      existing.messages++;
      existing.stamps += stampCount;
    }
  }

  return stats;
}

function writeResult(output: NodeJS.WritableStream, stats: Map<string, ChannelStats>): void {
  const keys = Array.from(stats.keys()).sort();
  for (const key of keys) {
    const s = stats.get(key)!;
    const meanLen = s.totalLen / s.messages;
    output.write(`${key}=${s.minLen}/${formatFixed2(meanLen)}/${s.maxLen}/${s.messages}/${s.stamps}\n`);
  }
}

function formatFixed2(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);

  const bits = view.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  let mantissa: bigint;
  let exponent: number;
  if (exponentBits === 0) {
    mantissa = fraction;
    exponent = -1022 - 52;
  } else {
    mantissa = (1n << 52n) | fraction;
    exponent = exponentBits - 1023 - 52;
  }

  let scaled = mantissa * 100n;
  let cents: bigint;
  if (exponent >= 0) {
    cents = scaled << BigInt(exponent);
  } else {
    const denominator = 1n << BigInt(-exponent);
    cents = scaled / denominator;
    const remainder = scaled % denominator;
    const twice = remainder * 2n;
    if (twice > denominator || (twice === denominator && cents % 2n === 1n)) {
      cents++;
    }
  }

  const whole = cents / 100n;
  const decimal = cents % 100n;
  return `${whole}.${decimal.toString().padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = options.input === "" ? process.stdin : fs.createReadStream(options.input, { encoding: "utf8" });
  const output = options.output === "" ? process.stdout : fs.createWriteStream(options.output, { encoding: "utf8" });
  const stats = await analyze(input);
  writeResult(output, stats);
  if (output !== process.stdout) {
    await new Promise<void>((resolve) => output.end(resolve));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
