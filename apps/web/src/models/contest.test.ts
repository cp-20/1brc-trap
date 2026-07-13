import { describe, expect, it } from "vitest";
import { hasContestStarted, isSubmissionOpen } from "./contest.js";

const contest = {
  startAt: "2026-07-20T00:00:00.000Z",
  endAt: "2026-07-21T00:00:00.000Z",
};

describe("contest schedule", () => {
  it("開始前はルールと提出を閉じる", () => {
    const now = new Date("2026-07-19T23:59:59.999Z");
    expect(hasContestStarted(contest, now)).toBe(false);
    expect(isSubmissionOpen(contest, now)).toBe(false);
  });

  it("開始時刻から終了時刻までは提出を受け付ける", () => {
    expect(
      isSubmissionOpen(contest, new Date("2026-07-20T00:00:00.000Z")),
    ).toBe(true);
    expect(
      isSubmissionOpen(contest, new Date("2026-07-21T00:00:00.000Z")),
    ).toBe(true);
  });

  it("終了後もルールは公開し、提出だけ閉じる", () => {
    const now = new Date("2026-07-21T00:00:00.001Z");
    expect(hasContestStarted(contest, now)).toBe(true);
    expect(isSubmissionOpen(contest, now)).toBe(false);
  });
});
