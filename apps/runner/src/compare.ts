import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { ResultAsync, err, ok, type Result } from "neverthrow";

export type ComparisonError = {
  code: "malformed" | "duplicate" | "missing" | "extra" | "mismatch" | "io";
  message: string;
};

export function compareOutput(
  actualPath: string,
  expectedPath: string,
): ResultAsync<void, ComparisonError> {
  return ResultAsync.fromPromise(loadRecords(expectedPath), ioError).andThen(
    (expected) =>
      ResultAsync.fromPromise(loadRecords(actualPath), ioError).andThen(
        (actual) => compareRecords(actual, expected),
      ),
  );
}

export function compareRecords(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): Result<void, ComparisonError> {
  for (const [key, value] of actual) {
    const wanted = expected.get(key);
    if (wanted === undefined)
      return err({ code: "extra", message: `unexpected key: ${key}` });
    if (wanted !== value)
      return err({ code: "mismatch", message: `value mismatch: ${key}` });
  }
  for (const key of expected.keys()) {
    if (!actual.has(key))
      return err({ code: "missing", message: `missing key: ${key}` });
  }
  return ok(undefined);
}

async function loadRecords(path: string): Promise<Map<string, string>> {
  const records = new Map<string, string>();
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    if (raw.length === 0) continue;
    const line = raw;
    const separator = line.indexOf("=");
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`malformed line ${lineNumber}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (records.has(key))
      throw new Error(`duplicate key on line ${lineNumber}: ${key}`);
    if (!/^\d+\/\d+\.\d{2}\/\d+\/\d+\/\d+$/.test(value)) {
      throw new Error(`malformed value on line ${lineNumber}: ${key}`);
    }
    records.set(key, value);
  }
  return records;
}

function ioError(cause: unknown): ComparisonError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.startsWith("duplicate")) return { code: "duplicate", message };
  if (message.startsWith("malformed")) return { code: "malformed", message };
  return { code: "io", message };
}
