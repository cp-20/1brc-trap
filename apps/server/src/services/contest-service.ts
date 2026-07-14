import { benchmarkPolicy, type LeaderboardEntry } from "@1brc/domain";
import { errAsync, ResultAsync } from "neverthrow";
import { buildLeaderboard } from "../domain/leaderboard.js";
import type { Config } from "../infrastructures/config.js";
import type { R2Signer } from "../infrastructures/r2-signer.js";
import type { ContestRepository } from "../repositories/contest-repository.js";
import { AppError } from "../utils/errors.js";
import { createResultCache } from "../utils/result-cache.js";

type LiveSnapshot = {
  contest: {
    privatePublishedAt: string | null;
    participants: number;
    totalSubmissions: number;
  };
  leaderboard: {
    board: "public" | "private";
    privatePublished: boolean;
    ranked: LeaderboardEntry[];
    disqualified: LeaderboardEntry[];
  };
};

export type ContestService = ReturnType<typeof createContestService>;

export function createContestService(
  repository: ContestRepository,
  signer: R2Signer,
  config: Config,
) {
  const liveSnapshotCache = createResultCache<LiveSnapshot, AppError>(1_000);

  return {
    overview() {
      return ResultAsync.combine([
        repository.state(),
        repository.participationStats(),
      ]).map(([state, participation]) => ({
        id: config.CONTEST_ID,
        name: "1BRC for traP",
        startAt: config.CONTEST_START_AT.toISOString(),
        endAt: config.CONTEST_END_AT.toISOString(),
        privatePublishedAt: state?.private_published_at?.toISOString() ?? null,
        ...participation,
        environment: {
          id: config.BENCHMARK_ENVIRONMENT_ID,
          instanceType: config.BENCHMARK_INSTANCE_TYPE,
          cpu: config.BENCHMARK_CPU,
          memory: config.BENCHMARK_MEMORY,
          os: "Ubuntu 26.04 LTS",
          kernel: config.BENCHMARK_KERNEL,
          docker: config.BENCHMARK_DOCKER_VERSION,
          runnerImage: config.BENCHMARK_RUNNER_IMAGE,
          node: config.BENCHMARK_NODE_VERSION,
          bun: config.BENCHMARK_BUN_VERSION,
          ruby: config.BENCHMARK_RUBY_VERSION,
          sharedLibraries: config.BENCHMARK_SHARED_LIBRARIES.split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          ...benchmarkPolicy,
        },
      }));
    },
    leaderboard(
      requestedBoard: string | undefined,
      language: string | undefined,
    ) {
      return ResultAsync.combine([
        repository.privatePublished(),
        repository.leaderboard(language),
      ]).map(([privatePublished, rows]) => {
        const board =
          requestedBoard === "private" && privatePublished
            ? "private"
            : "public";
        return buildLeaderboard(rows, board, privatePublished);
      });
    },
    liveSnapshot(
      requestedBoard: string | undefined,
      language: string | undefined,
    ) {
      const key = `${requestedBoard ?? "public"}:${language ?? "all"}`;
      return liveSnapshotCache(key, () =>
        ResultAsync.combine([
          repository.state(),
          repository.participationStats(),
          repository.leaderboard(language),
        ]).map(([state, participation, rows]) => {
          const privatePublished = Boolean(state?.private_published_at);
          const board =
            requestedBoard === "private" && privatePublished
              ? "private"
              : "public";
          return {
            contest: {
              privatePublishedAt:
                state?.private_published_at?.toISOString() ?? null,
              ...participation,
            },
            leaderboard: buildLeaderboard(rows, board, privatePublished),
          };
        }),
      );
    },
    publicDatasets() {
      return repository.publicDatasets(config.CONTEST_ID).map((rows) =>
        rows.map((row) => ({
          id: row.artifact_id,
          kind: row.kind,
          label: row.label,
          rows: row.rows_count,
          compressedBytes: row.compressed_bytes,
          uncompressedBytes: row.uncompressed_bytes,
          compressedSha256: row.compressed_sha256,
          uncompressedSha256: row.uncompressed_sha256,
          downloadUrl: `/api/v1/datasets/${encodeURIComponent(row.artifact_id.replace(/-(input|expected)$/, ""))}/${row.kind}/download`,
        })),
      );
    },
    signedDatasetDownload(datasetId: string, artifact: string) {
      if (artifact !== "input" && artifact !== "expected") {
        return errAsync(
          new AppError(
            "not_found",
            "dataset_not_found",
            "公開データが見つかりません",
          ),
        );
      }
      return repository
        .publicDataset(config.CONTEST_ID, `${datasetId}-${artifact}`)
        .andThen((dataset) => {
          if (
            !dataset ||
            !dataset.object_key.startsWith(
              `datasets/${config.CONTEST_ID}/public/`,
            )
          ) {
            return errAsync(
              new AppError(
                "not_found",
                "dataset_not_found",
                "公開データが見つかりません",
              ),
            );
          }
          const filename =
            dataset.object_key.split("/").pop() ?? `${dataset.artifact_id}.zst`;
          return signer.signDownload(dataset.object_key, filename);
        });
    },
  };
}
