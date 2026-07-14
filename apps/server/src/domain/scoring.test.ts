import { describe, expect, it } from "vitest";
import { buildBenchmarkResult, medianNs } from "./scoring.js";

describe("medianNs", () => {
  it("returns the middle duration without converting to number", () => {
    expect(medianNs([9_007_199_254_740_999n, 7n, 11n])).toBe(11n);
  });
  it("uses the only duration when later attempts are skipped", () => {
    expect(medianNs([60_000_000_001n])).toBe(60_000_000_001n);
  });
  it("redacts durations for a failed benchmark", () => {
    expect(buildBenchmarkResult("wrong_answer", [1n, 2n, 3n])).toEqual({
      verdict: "wrong_answer",
      durationsNs: null,
      medianNs: null,
      error: null,
    });
  });
});
