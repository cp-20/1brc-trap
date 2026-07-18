import { describe, expectTypeOf, it } from "bun:test";

import type { SubmissionStatus } from "@1brc/domain";

import { apiTokens, datasetReleases, submissions } from "./schema.js";

describe("database schema inference", () => {
  it("DB固有型とdomain enumを手書きのrow型なしで推論する", () => {
    type Submission = typeof submissions.$inferSelect;
    type Token = typeof apiTokens.$inferSelect;
    type Dataset = typeof datasetReleases.$inferSelect;

    expectTypeOf<Submission["status"]>().toEqualTypeOf<SubmissionStatus>();
    expectTypeOf<Submission["public_score_ns"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<Token["token_hash"]>().toEqualTypeOf<Buffer>();
    expectTypeOf<Dataset["kind"]>().toEqualTypeOf<"input" | "expected">();
  });
});
