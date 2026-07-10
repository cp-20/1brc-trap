import { describe, expect, it } from "vitest";
import { compareRecords } from "./compare.js";

describe("compareRecords", () => {
  it("accepts different insertion order", () => {
    const actual = new Map([
      ["b,2027-01", "1/1.00/1/1/0"],
      ["a,2027-01", "2/2.00/2/1/1"],
    ]);
    const expected = new Map([...actual].reverse());
    expect(compareRecords(actual, expected).isOk()).toBe(true);
  });
  it("rejects missing and mismatched values", () => {
    expect(
      compareRecords(
        new Map(),
        new Map([["a", "1/1.00/1/1/0"]]),
      )._unsafeUnwrapErr().code,
    ).toBe("missing");
    expect(
      compareRecords(
        new Map([["a", "1/1.00/1/1/1"]]),
        new Map([["a", "1/1.00/1/1/0"]]),
      )._unsafeUnwrapErr().code,
    ).toBe("mismatch");
  });

  it("does not ignore whitespace around a key", () => {
    expect(
      compareRecords(
        new Map([[" a", "1/1.00/1/1/0"]]),
        new Map([["a", "1/1.00/1/1/0"]]),
      ).isErr(),
    ).toBe(true);
  });
});
