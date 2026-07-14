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
});
