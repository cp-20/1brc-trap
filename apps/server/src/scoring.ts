import type { BenchmarkResult, Verdict } from "@1brc/contracts";

export function medianNs(values: readonly bigint[]): bigint {
  if (values.length !== 3)
    throw new Error("exactly three durations are required");
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[1]!;
}

export function buildBenchmarkResult(
  verdict: Verdict,
  values: readonly bigint[],
): BenchmarkResult {
  if (verdict !== "accepted" || values.length !== 3) {
    return { verdict, durationsNs: null, medianNs: null };
  }
  const durations = values.map(String) as [string, string, string];
  return {
    verdict,
    durationsNs: durations,
    medianNs: medianNs(values).toString(),
  };
}
