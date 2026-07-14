import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { createResultCache } from "./result-cache.js";

describe("createResultCache", () => {
  it("同じkeyの同時loadを共有する", async () => {
    const load = vi.fn(() => okAsync<string, Error>("value"));
    const cached = createResultCache<string, Error>(1_000);
    const [first, second] = await Promise.all([
      cached("key", load),
      cached("key", load),
    ]);
    expect(first.isOk() && first.value).toBe("value");
    expect(second.isOk() && second.value).toBe("value");
    expect(load).toHaveBeenCalledOnce();
  });

  it("失敗時も短時間はloadを共有する", async () => {
    const load = vi.fn(() => errAsync<string, Error>(new Error("failed")));
    const cached = createResultCache<string, Error>(1_000);
    await cached("key", load);
    await cached("key", load);
    expect(load).toHaveBeenCalledOnce();
  });

  it("TTL後は新しい値を読み込み、SSEへ古い状態を配り続けない", async () => {
    vi.useFakeTimers();
    try {
      const load = vi
        .fn()
        .mockReturnValueOnce(okAsync<string, Error>("first"))
        .mockReturnValueOnce(okAsync<string, Error>("second"));
      const cached = createResultCache<string, Error>(1_000);
      await cached("key", load);

      await vi.advanceTimersByTimeAsync(1_001);
      const result = await cached("key", load);

      expect(result.isOk() && result.value).toBe("second");
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
