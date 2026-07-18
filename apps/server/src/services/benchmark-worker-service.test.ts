import { describe, expect, it, vi } from "bun:test";

import { errAsync, okAsync } from "neverthrow";

import { AppError } from "../utils/errors.js";
import { retryResultUntilStopped } from "./benchmark-worker-service.js";

describe("benchmark infrastructure failure", () => {
  it("DBが一時的に失敗してもrunningを残さず、復旧まで状態更新を再試行する", async () => {
    const databaseError = new AppError(
      "infrastructure",
      "database_error",
      "database unavailable",
    );
    const markFailure = vi
      .fn()
      .mockReturnValueOnce(errAsync(databaseError))
      .mockReturnValueOnce(okAsync(undefined));
    const onRetry = vi.fn();
    const wait = vi.fn(async () => undefined);

    expect(
      await retryResultUntilStopped(markFailure, {
        isStopping: () => false,
        onRetry,
        wait,
      }),
    ).toBe(true);

    expect(markFailure).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(databaseError);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
