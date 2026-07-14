import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../utils/errors.js";
import { persistInfrastructureFailure } from "./benchmark-worker-service.js";

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

    await expect(
      persistInfrastructureFailure(markFailure, {
        isStopping: () => false,
        onRetry,
        wait,
      }),
    ).resolves.toBe(true);

    expect(markFailure).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(databaseError);
    expect(wait).toHaveBeenCalledOnce();
  });
});
