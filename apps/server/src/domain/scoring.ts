import type { BenchmarkResult, Verdict } from "@1brc/contracts";

export function medianNs(values: readonly bigint[]): bigint {
  if (values.length !== 1 && values.length !== 3)
    throw new Error("exactly one or three durations are required");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function buildBenchmarkResult(
  verdict: Verdict,
  values: readonly bigint[],
): BenchmarkResult {
  if (verdict !== "accepted" || (values.length !== 1 && values.length !== 3)) {
    return { verdict, durationsNs: null, medianNs: null, error: null };
  }
  const durations = values.map(String) as [string] | [string, string, string];
  return {
    verdict,
    durationsNs: durations,
    medianNs: medianNs(values).toString(),
    error: null,
  };
}
