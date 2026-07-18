import { describe, expect, it, vi } from "bun:test";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { submissionPolicy } from "@1brc/domain";
import { errAsync, okAsync } from "neverthrow";

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
    const { service, repository, runner } = fixture(id);
    runner.upload.mockReturnValue(errAsync(runnerFailure));
    runner.cleanup.mockReturnValue(errAsync(cleanupFailure));
    repository.discardUpload.mockReturnValue(errAsync(discardFailure));

    const result = await service.accept("user", uploadRequest());

    expect(result.isErr() && result.error).toBe(runnerFailure);
    expect(repository.storeSource).toHaveBeenCalledTimes(1);
    expect(repository.queueUpload).not.toHaveBeenCalled();
    expect(runner.cleanup).toHaveBeenCalledWith(id);
    expect(repository.discardUpload).toHaveBeenCalledWith(id);
    await expectTemporaryDirectoryRemoved(id);
  });

  it("sourceの上限超過をstream中に拒否し、DBとrunnerへ不完全な提出を渡さない", async () => {
    const id = "1198d9ec-9024-4d69-8bb8-9c13a73f6768";
    const { service, repository, runner } = fixture(id);
    const form = new FormData();
    form.set("executionKind", "typescript");
    form.set(
      "source",
      new File(
        [new Uint8Array(submissionPolicy.sourceLimitBytes + 1)],
        "main.ts",
      ),
    );

    const result = await service.accept("user", uploadRequest(form));

    expect(result.isErr() && result.error.code).toBe("invalid_source");
    expect(repository.storeSource).not.toHaveBeenCalled();
    expect(runner.upload).not.toHaveBeenCalled();
    expect(repository.discardUpload).toHaveBeenCalledWith(id);
    await expectTemporaryDirectoryRemoved(id);
  });

  it("同じmetadataを複数送る曖昧なmultipartを拒否する", async () => {
    const id = "2198d9ec-9024-4d69-8bb8-9c13a73f6768";
    const { service, repository } = fixture(id);
    const form = validForm();
    form.append("executionKind", "javascript");

    const result = await service.accept("user", uploadRequest(form));

    expect(result.isErr() && result.error.code).toBe("invalid_metadata");
    expect(repository.storeSource).not.toHaveBeenCalled();
    expect(repository.discardUpload).toHaveBeenCalledWith(id);
    await expectTemporaryDirectoryRemoved(id);
  });

  it("client切断を通常のvalidation errorと区別し、予約を破棄する", async () => {
    const id = "3198d9ec-9024-4d69-8bb8-9c13a73f6768";
    const { service, repository } = fixture(id);
    const controller = new AbortController();
    const request = uploadRequest(validForm(), controller.signal);
    controller.abort();

    const result = await service.accept("user", request);

    expect(result.isErr() && result.error.code).toBe("upload_aborted");
    expect(repository.storeSource).not.toHaveBeenCalled();
    expect(repository.discardUpload).toHaveBeenCalledWith(id);
    await expectTemporaryDirectoryRemoved(id);
  });
});

function fixture(id: string) {
  const repository = {
    reserve: vi.fn(() =>
      okAsync<{ id: string; uploadStartedAt: string }, AppError>({
        id,
        uploadStartedAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
    storeSource: vi.fn(() => okAsync<void, AppError>(undefined)),
    queueUpload: vi.fn(() => okAsync<void, AppError>(undefined)),
    discardUpload: vi.fn(() => okAsync<void, AppError>(undefined)),
  };
  const runner = {
    upload: vi.fn(() => okAsync<void, AppError>(undefined)),
    cleanup: vi.fn(() => okAsync<void, AppError>(undefined)),
  };
  return {
    repository,
    runner,
    service: createSubmissionService(
      repository as unknown as SubmissionRepository,
      runner as unknown as RunnerClient,
      {} as Config,
    ),
  };
}

function validForm() {
  const form = new FormData();
  form.set("executionKind", "typescript");
  form.set("source", new File(["console.log('hello');\n"], "main.ts"));
  return form;
}

function uploadRequest(form = validForm(), signal?: AbortSignal) {
  return new Request("http://localhost/api/v1/submissions", {
    method: "POST",
    body: form,
    ...(signal ? { signal } : {}),
  });
}

async function expectTemporaryDirectoryRemoved(id: string) {
  const exists = await access(join(tmpdir(), `1brc-upload-${id}`)).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(false);
}
