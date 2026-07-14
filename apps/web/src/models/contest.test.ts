import { describe, expect, it } from "vitest";

import { getContestPhase } from "./contest.js";

const contest = {
  startAt: "2026-07-20T00:00:00.000Z",
  endAt: "2026-07-21T00:00:00.000Z",
};

describe("contest phase presentation", () => {
  it("開始前・開催中・終了後の表示を返す", () => {
    expect(
      getContestPhase(contest, new Date("2026-07-19T23:59:59.999Z")).label,
    ).toBe("開始まで");
    expect(
      getContestPhase(contest, new Date("2026-07-20T00:00:00.000Z")).label,
    ).toBe("終了まで");
    expect(
      getContestPhase(contest, new Date("2026-07-21T00:00:00.000Z")).label,
    ).toBe("終了まで");
    expect(
      getContestPhase(contest, new Date("2026-07-21T00:00:00.001Z")).label,
    ).toBe("終了");
  });
});
