import { describe, expect, it } from "vitest";
import {
  executionKindSchema,
  inferLanguage,
  sourceExtensions,
} from "./index.js";

describe("Bun提出形式", () => {
  it("Bunを実行形式と言語として扱う", () => {
    expect(executionKindSchema.parse("bun")).toBe("bun");
    expect(inferLanguage("bun")).toBe("bun");
  });

  it("JavaScriptとTypeScriptの単一source fileを許可する", () => {
    expect(sourceExtensions.bun).toEqual([".js", ".ts"]);
  });
});
