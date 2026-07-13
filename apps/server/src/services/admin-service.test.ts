import type { DatasetManifest } from "@1brc/contracts";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../infrastructures/config.js";
import type { R2Signer } from "../infrastructures/r2-signer.js";
import type { AdminRepository } from "../repositories/admin-repository.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";
import { createAdminService } from "./admin-service.js";

describe("dataset manifest import", () => {
  it("公開オブジェクトを確認してから取込完了件数を返す", async () => {
    const importDatasetManifest = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const verifyObject = vi.fn(() => okAsync(undefined));
    const service = createService(
      { importDatasetManifest, audit },
      verifyObject,
    );

    await expect(
      service.importDatasetManifest("admin", manifest),
    ).resolves.toBe(2);
    expect(verifyObject).toHaveBeenCalledOnce();
    expect(verifyObject).toHaveBeenCalledWith(
      "datasets/contest/public/input.csv.zst",
    );
    expect(importDatasetManifest).toHaveBeenCalledWith(
      manifest,
      expect.objectContaining({ CONTEST_ID: "contest" }),
    );
  });

  it("R2で公開オブジェクトを確認できなければ取り込まない", async () => {
    const importDatasetManifest = vi.fn(async () => undefined);
    const failure = new AppError(
      "infrastructure",
      "r2_object_unavailable",
      "R2上の公開データを確認できません",
    );
    const service = createService(
      { importDatasetManifest, audit: vi.fn(async () => undefined) },
      vi.fn(() => errAsync(failure)),
    );

    await expect(service.importDatasetManifest("admin", manifest)).rejects.toBe(
      failure,
    );
    expect(importDatasetManifest).not.toHaveBeenCalled();
  });
});

const manifest: DatasetManifest = {
  schemaVersion: 1,
  contestId: "contest",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generatorRevision: "test",
  artifacts: [
    artifact("public-input", "datasets/contest/public/input.csv.zst", true),
    artifact("private-input", "datasets/contest/private/input.csv.zst", false),
  ],
};

function artifact(id: string, objectKey: string, isPublic: boolean) {
  return {
    id,
    kind: "input" as const,
    label: id,
    objectKey,
    rows: 1,
    compressedBytes: 1,
    uncompressedBytes: 1,
    compressedSha256: "0".repeat(64),
    uncompressedSha256: "1".repeat(64),
    isPublic,
  };
}

function createService(
  administration: Pick<AdminRepository, "importDatasetManifest" | "audit">,
  verifyObject: Pick<R2Signer, "verifyObject">["verifyObject"],
) {
  return createAdminService(
    administration as AdminRepository,
    {} as SubmissionRepository,
    { CONTEST_ID: "contest" } as Config,
    { verifyObject },
  );
}
