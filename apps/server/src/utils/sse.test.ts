import { describe, expect, it, vi } from "bun:test";

import { okAsync } from "neverthrow";

import { streamJsonChanges } from "./sse.js";

describe("streamJsonChanges", () => {
  it("同じJSONを再送しない", async () => {
    const writes: unknown[] = [];
    let sleeps = 0;
    const stream = {
      closed: false,
      aborted: false,
      writeSSE: vi.fn((event) => {
        writes.push(event);
      }),
      sleep: vi.fn(() => {
        if (++sleeps === 2) stream.closed = true;
      }),
    };

    await streamJsonChanges(stream as never, {
      event: "update",
      load: () => okAsync({ value: "x".repeat(1_000_000) }),
      heartbeatMs: Infinity,
    });

    expect(writes).toHaveLength(1);
  });

  it("同じcacheKeyのJSON生成を接続間で共有する", async () => {
    const load = vi.fn(() => okAsync({ value: "x".repeat(1_000_000) }));
    const createStream = () => {
      const stream = {
        closed: false,
        aborted: false,
        writeSSE: vi.fn(),
        sleep: vi.fn(() => {
          stream.closed = true;
        }),
      };
      return stream;
    };
    const first = createStream();
    const second = createStream();

    await Promise.all([
      streamJsonChanges(first as never, {
        event: "update",
        cacheKey: "shared-test",
        load,
      }),
      streamJsonChanges(second as never, {
        event: "update",
        cacheKey: "shared-test",
        load,
      }),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first.writeSSE).toHaveBeenCalledWith(
      second.writeSSE.mock.calls[0]![0],
    );
  });
});
