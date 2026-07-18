import { describe, expect, test } from "bun:test";

import { highlightDiff } from "./syntax-highlighter.js";

describe("highlightDiff", () => {
  test("keeps C++ highlighting and adds diff gutters", async () => {
    const html = await highlightDiff(
      "-int old_value = 1;\n+int new_value = 2;",
      "cpp",
    );

    expect(html).toContain("diff-removed");
    expect(html).toContain("diff-added");
    expect(html).toContain('class="diff-marker">-</span>');
    expect(html).toContain('class="diff-marker">+</span>');
    expect(html).not.toContain("-int old_value");
  });
});
