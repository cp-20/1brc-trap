import { buildLeaderboard } from "../domain/leaderboard.js";
import type { Config } from "../infrastructures/config.js";
import type { R2Signer } from "../infrastructures/r2-signer.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";
import type { ContestRepository } from "../repositories/contest-repository.js";
import { AppError } from "../utils/errors.js";

export type ContestService = ReturnType<typeof createContestService>;

export function createContestService(
  repository: ContestRepository,
  signer: R2Signer,
  config: Config,
  runner: RunnerClient,
) {
  return {
    async overview() {
      const [state, participation, runtimeEnvironment] = await Promise.all([
        repository.state(),
        repository.participationStats(),
        runner.environment().match(
          (environment) => environment,
          () => ({
            cpu: config.BENCHMARK_CPU,
            memory: config.BENCHMARK_MEMORY,
          }),
        ),
      ]);
      return {
        id: config.CONTEST_ID,
        name: "1BRC for traP",
        startAt: config.CONTEST_START_AT.toISOString(),
        endAt: config.CONTEST_END_AT.toISOString(),
        privatePublishedAt: state?.private_published_at?.toISOString() ?? null,
        ...participation,
        environment: {
          id: config.BENCHMARK_ENVIRONMENT_ID,
          instanceType: config.BENCHMARK_INSTANCE_TYPE,
          cpu: runtimeEnvironment.cpu,
          memory: runtimeEnvironment.memory,
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
          repetitions: 3,
          timeoutSeconds: 900,
          pidLimit: 4096,
          outputLimitBytes: 256 * 1024 * 1024,
        },
      };
    },
    async leaderboard(
      requestedBoard: string | undefined,
      language: string | undefined,
    ) {
      const privatePublished = await repository.privatePublished();
      const board =
        requestedBoard === "private" && privatePublished ? "private" : "public";
      return buildLeaderboard(
        await repository.leaderboard(language),
        board,
        privatePublished,
      );
    },
    async liveSnapshot(
      requestedBoard: string | undefined,
      language: string | undefined,
    ) {
      const [state, participation, rows] = await Promise.all([
        repository.state(),
        repository.participationStats(),
        repository.leaderboard(language),
      ]);
      const privatePublished = Boolean(state?.private_published_at);
      const board =
        requestedBoard === "private" && privatePublished ? "private" : "public";
      return {
        contest: {
          privatePublishedAt:
            state?.private_published_at?.toISOString() ?? null,
          ...participation,
        },
        leaderboard: buildLeaderboard(rows, board, privatePublished),
      };
    },
    async publicDatasets() {
      const rows = await repository.publicDatasets(config.CONTEST_ID);
      return rows.map((row) => ({
        id: row.artifact_id,
        kind: row.kind,
        label: row.label,
        rows: row.rows_count,
        compressedBytes: row.compressed_bytes,
        uncompressedBytes: row.uncompressed_bytes,
        compressedSha256: row.compressed_sha256,
        uncompressedSha256: row.uncompressed_sha256,
        downloadUrl: `/api/v1/datasets/${encodeURIComponent(row.artifact_id.replace(/-(input|expected)$/, ""))}/${row.kind}/download`,
      }));
    },
    async signedDatasetDownload(datasetId: string, artifact: string) {
      if (artifact !== "input" && artifact !== "expected") {
        throw new AppError(
          "not_found",
          "dataset_not_found",
          "公開データが見つかりません",
        );
      }
      const dataset = await repository.publicDataset(
        config.CONTEST_ID,
        `${datasetId}-${artifact}`,
      );
      if (
        !dataset ||
        !dataset.object_key.startsWith(`datasets/${config.CONTEST_ID}/public/`)
      ) {
        throw new AppError(
          "not_found",
          "dataset_not_found",
          "公開データが見つかりません",
        );
      }
      const filename =
        dataset.object_key.split("/").pop() ?? `${dataset.artifact_id}.zst`;
      const signed = await signer.signDownload(dataset.object_key, filename);
      if (signed.isErr()) throw signed.error;
      return signed.value;
    },
  };
}
