import { describe, expect, it } from "bun:test";

import { cppOptimizationStages } from "./stages.js";

describe("C++ optimization guide", () => {
  it("orders complete sources from the naive version and explains each change", () => {
    expect(cppOptimizationStages).toHaveLength(9);
    expect(cppOptimizationStages[0]?.diff).toBeNull();
    for (const stage of cppOptimizationStages) {
      expect(stage.source).toContain("int main(");
      expect(stage.diagnosis).toBeTruthy();
      expect(stage.verification).toBeTruthy();
      expect(stage.explanation.length).toBeGreaterThan(0);
      expect(stage.benchmark.wallSeconds).toBeGreaterThan(0);
      expect(stage.benchmark.nextEvidence).toBeTruthy();
    }
    for (const stage of cppOptimizationStages.slice(1)) {
      expect(stage.diff).toMatch(/^[+-]/m);
      expect(stage.diffNote).toBeTruthy();
    }
    const times = cppOptimizationStages.map(
      (stage) => stage.benchmark.wallSeconds,
    );
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });
});
