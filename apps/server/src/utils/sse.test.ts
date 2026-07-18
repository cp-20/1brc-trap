import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

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
});
