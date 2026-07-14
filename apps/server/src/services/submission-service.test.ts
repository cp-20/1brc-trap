import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../infrastructures/config.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";
import { createSubmissionService } from "./submission-service.js";

describe("submission upload cleanup", () => {
  it("runnerへのupload失敗時は予約と一時ファイルを破棄し、元の失敗を返す", async () => {
    const id = "0198d9ec-9024-4d69-8bb8-9c13a73f6768";
    const runnerFailure = new AppError(
      "infrastructure",
      "runner_unavailable",
      "runner unavailable",
    );
    const cleanupFailure = new AppError(
      "infrastructure",
      "runner_unavailable",
      "cleanup unavailable",
    );
    const discardFailure = new AppError(
      "infrastructure",
      "database_error",
      "database unavailable",
    );
    const repository = {
      reserve: vi.fn(() =>
        okAsync({ id, uploadStartedAt: "2026-01-01T00:00:00.000Z" }),
      ),
      storeSource: vi.fn(() => okAsync(undefined)),
      queueUpload: vi.fn(() => okAsync(undefined)),
      discardUpload: vi.fn(() => errAsync(discardFailure)),
    };
    const runner = {
      upload: vi.fn(() => errAsync(runnerFailure)),
      cleanup: vi.fn(() => errAsync(cleanupFailure)),
    };
    const service = createSubmissionService(
      repository as unknown as SubmissionRepository,
      runner as unknown as RunnerClient,
      {} as Config,
    );
    const form = new FormData();
    form.set("executionKind", "typescript");
    form.set(
      "source",
      new File(["console.log('hello');\n"], "main.ts", {
        type: "text/plain",
      }),
    );

    const result = await service.accept(
      "user",
      new Request("http://localhost/api/v1/submissions", {
        method: "POST",
        body: form,
      }),
    );

    expect(result.isErr() && result.error).toBe(runnerFailure);
    expect(repository.storeSource).toHaveBeenCalledOnce();
    expect(repository.queueUpload).not.toHaveBeenCalled();
    expect(runner.cleanup).toHaveBeenCalledWith(id);
    expect(repository.discardUpload).toHaveBeenCalledWith(id);
    await expect(access(join(tmpdir(), `1brc-upload-${id}`))).rejects.toThrow();
  });
});
