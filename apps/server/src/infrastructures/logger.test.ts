import { describe, expect, it } from "bun:test";

import { AppError } from "../utils/errors.js";
import { serializeError } from "./logger.js";

describe("serializeError", () => {
  it("AppErrorの原因をログ用オブジェクトへ展開する", () => {
    const cause = Object.assign(new Error("runner exited 1: invalid input"), {
      code: "ERUNNER",
    });
    const error = new AppError(
      "infrastructure",
      "runner_unavailable",
      "runner unavailable",
      cause,
    );

    expect(serializeError(error)).toMatchObject({
      name: "AppError",
      message: "runner unavailable",
      cause: {
        name: "Error",
        message: "runner exited 1: invalid input",
        code: "ERUNNER",
      },
    });
  });
});
