import { describe, expect, it } from "vitest";
import { shouldStopAfterFirstAttempt } from "./benchmark-policy.js";

describe("shouldStopAfterFirstAttempt", () => {
  it("stops only when the first attempt exceeds 60 seconds", () => {
    expect(shouldStopAfterFirstAttempt(1, "60000000000")).toBe(false);
    expect(shouldStopAfterFirstAttempt(1, "60000000001")).toBe(true);
    expect(shouldStopAfterFirstAttempt(2, "60000000001")).toBe(false);
  });
});
