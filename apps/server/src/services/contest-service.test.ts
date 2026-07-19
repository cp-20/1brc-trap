import { describe, expect, it, vi } from "bun:test";

import { benchmarkPolicy } from "@1brc/domain";
import { okAsync } from "neverthrow";

import type { Config } from "../infrastructures/config.js";
import type { R2Signer } from "../infrastructures/r2-signer.js";
import type { ContestRepository } from "../repositories/contest-repository.js";
import { createContestService } from "./contest-service.js";

describe("contest policy", () => {
  it("APIで公開する計測条件を共有domain policyと一致させる", async () => {
    const repository = {
      state: vi.fn(() => okAsync(null)),
      participationStats: vi.fn(() =>
        okAsync({ participants: 0, totalSubmissions: 0 }),
      ),
    };
    const service = createContestService(
      repository as unknown as ContestRepository,
      {} as R2Signer,
      contestConfig,
    );

    const result = await service.overview();

    expect(result.isOk() && result.value.environment).toMatchObject(
      benchmarkPolicy,
    );
  });

  it("Private公開前のprivate指定をpublic boardへ固定する", async () => {
    const repository = {
      privatePublished: vi.fn(() => okAsync(false)),
      leaderboard: vi.fn(() => okAsync([])),
    };
    const service = createContestService(
      repository as unknown as ContestRepository,
      {} as R2Signer,
      contestConfig,
    );

    const result = await service.leaderboard("private", undefined);

    expect(result.isOk() && result.value.board).toBe("public");
  });

  it("管理者の参考提出をリーダーボードと順位推移から除外する", async () => {
    const adminRow = {
      username: "admin",
      submission_id: "admin-submission",
      language: "c" as const,
      public_verdict: "accepted" as const,
      public_score_ns: "1",
      private_verdict: "accepted" as const,
      private_score_ns: "1",
      disqualified_reason: null,
      submitted_at: new Date("2026-01-01T00:00:00Z"),
    };
    const repository = {
      privatePublished: vi.fn(() => okAsync(true)),
      leaderboard: vi.fn(() => okAsync([adminRow])),
      leaderboardReplay: vi.fn(() =>
        okAsync([{ username: "admin", submissionId: "admin-submission" }]),
      ),
    };
    const service = createContestService(
      repository as unknown as ContestRepository,
      {} as R2Signer,
      {
        ...contestConfig,
        CONTEST_END_AT: new Date(Date.now() - 1_000),
        admins: new Set(["admin"]),
      },
    );

    const leaderboard = await service.leaderboard("public", undefined);
    const replay = await service.leaderboardReplay();

    expect(leaderboard.isOk() && leaderboard.value.ranked).toEqual([]);
    expect(replay.isOk() && replay.value).toEqual([]);
  });

  it("順位推移はコンテスト終了後かつPrivate公開後だけ返す", async () => {
    const beforeEndRepository = {
      privatePublished: vi.fn(() => okAsync(true)),
      leaderboardReplay: vi.fn(() => okAsync([])),
    };
    const beforeEndService = createContestService(
      beforeEndRepository as unknown as ContestRepository,
      {} as R2Signer,
      { ...contestConfig, CONTEST_END_AT: new Date(Date.now() + 60_000) },
    );

    const beforeEnd = await beforeEndService.leaderboardReplay();

    expect(beforeEnd.isErr() && beforeEnd.error.code).toBe("contest_not_ended");
    expect(beforeEndRepository.leaderboardReplay).not.toHaveBeenCalled();

    const unpublishedRepository = {
      privatePublished: vi.fn(() => okAsync(false)),
      leaderboardReplay: vi.fn(() => okAsync([])),
    };
    const unpublishedService = createContestService(
      unpublishedRepository as unknown as ContestRepository,
      {} as R2Signer,
      { ...contestConfig, CONTEST_END_AT: new Date(Date.now() - 1_000) },
    );

    const unpublished = await unpublishedService.leaderboardReplay();

    expect(unpublished.isErr() && unpublished.error.code).toBe(
      "private_not_published",
    );
    expect(unpublishedRepository.leaderboardReplay).not.toHaveBeenCalled();

    unpublishedRepository.privatePublished.mockImplementation(() =>
      okAsync(true),
    );
    const published = await unpublishedService.leaderboardReplay();

    expect(published.isOk() && published.value).toEqual([]);
    expect(unpublishedRepository.leaderboardReplay).toHaveBeenCalledTimes(1);
  });
});

const contestConfig = {
  CONTEST_ID: "contest",
  CONTEST_START_AT: new Date("2026-01-01T00:00:00Z"),
  CONTEST_END_AT: new Date("2026-02-01T00:00:00Z"),
  BENCHMARK_ENVIRONMENT_ID: "environment",
  BENCHMARK_INSTANCE_TYPE: "instance",
  BENCHMARK_CPU: "cpu",
  BENCHMARK_MEMORY: "memory",
  BENCHMARK_KERNEL: "kernel",
  BENCHMARK_DOCKER_VERSION: "docker",
  BENCHMARK_RUNNER_IMAGE: "image",
  BENCHMARK_NODE_VERSION: "node",
  BENCHMARK_BUN_VERSION: "bun",
  BENCHMARK_RUBY_VERSION: "ruby",
  BENCHMARK_SHARED_LIBRARIES: "libc",
  admins: new Set<string>(),
} as Config;
