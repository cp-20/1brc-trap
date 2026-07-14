import { benchmarkPolicy } from "@1brc/domain";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
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
} as Config;
