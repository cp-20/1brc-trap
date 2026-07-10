import { randomUUID } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import type { HttpBindings } from "@hono/node-server";
import { datasetManifestSchema, type LeaderboardEntry } from "@1brc/contracts";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { authMiddleware, type AppVariables, type AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import { issueAccessKey } from "./crypto.js";
import type { Database } from "./db.js";
import { AppError, errorStatus } from "./errors.js";
import type { Logger } from "./logger.js";
import type { R2Signer } from "./r2.js";
import type { SubmissionService } from "./submission-service.js";

type Env = { Bindings: HttpBindings; Variables: AppVariables };
type AppContext = Context<Env>;

type StateRow = RowDataPacket & {
  private_published_at: Date | null;
  worker_heartbeat_at: Date | null;
  benchmark_environment_id: string | null;
};

type SubmissionRow = RowDataPacket & {
  id: string;
  username: string;
  execution_kind: string | null;
  language: string | null;
  source_filename: string | null;
  artifact_sha256: string | null;
  status: string;
  public_verdict: string | null;
  public_score_ns: string | null;
  private_verdict: string | null;
  private_score_ns: string | null;
  public_error: string | null;
  infrastructure_error: string | null;
  disqualified_reason: string | null;
  upload_started_at: Date;
  queued_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

type DatasetRow = RowDataPacket & {
  contest_id: string;
  artifact_id: string;
  kind: "input" | "expected";
  label: string;
  object_key: string;
  rows_count: string;
  compressed_bytes: string;
  uncompressed_bytes: string;
  compressed_sha256: string;
  uncompressed_sha256: string;
};

type LeaderboardRow = RowDataPacket & {
  username: string;
  submission_id: string;
  language: LeaderboardEntry["language"];
  public_verdict: LeaderboardEntry["verdict"];
  public_score_ns: string | null;
  private_verdict: LeaderboardEntry["verdict"] | null;
  private_score_ns: string | null;
  disqualified_reason: string | null;
  submitted_at: Date;
};

export type AppDependencies = {
  config: Config;
  database: Database;
  signer: R2Signer;
  submissions: SubmissionService;
  logger: Logger;
};

export function createApiRoutes(dependencies: AppDependencies) {
  const { config, database, signer, submissions } = dependencies;
  const api = new Hono<Env>()
    .get("/healthz", (context) => context.json({ ok: true }))
    .get("/readyz", async (context) => {
      const result = await database.query<RowDataPacket[]>("SELECT 1 AS ok");
      return result.isOk()
        ? context.json({ ok: true })
        : context.json({ ok: false }, 503);
    })
    .get("/contest", async (context) => {
      const [stateResult, queueResult] = await Promise.all([
        database.query<StateRow[]>(
          "SELECT * FROM contest_state WHERE singleton_id = 1",
        ),
        database.query<(RowDataPacket & { active_count: number })[]>(
          "SELECT COUNT(*) AS active_count FROM submissions WHERE status IN ('uploading', 'queued', 'running')",
        ),
      ]);
      if (stateResult.isErr()) throw stateResult.error;
      if (queueResult.isErr()) throw queueResult.error;
      const state = stateResult.value[0];
      return context.json({
        id: config.CONTEST_ID,
        name: "1BRC for traP",
        startAt: config.CONTEST_START_AT.toISOString(),
        endAt: config.CONTEST_END_AT.toISOString(),
        privatePublishedAt: state?.private_published_at?.toISOString() ?? null,
        queueActive: Number(queueResult.value[0]?.active_count ?? 0),
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
          ruby: config.BENCHMARK_RUBY_VERSION,
          sharedLibraries: config.BENCHMARK_SHARED_LIBRARIES.split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          repetitions: 3,
          timeoutSeconds: 900,
          pidLimit: 4096,
          outputLimitBytes: 256 * 1024 * 1024,
        },
      });
    })
    .get("/me", (context) => context.json({ user: context.get("authUser") }))
    .get("/leaderboard", async (context) => {
      const stateResult = await database.query<StateRow[]>(
        "SELECT private_published_at FROM contest_state WHERE singleton_id = 1",
      );
      if (stateResult.isErr()) throw stateResult.error;
      const privatePublished = Boolean(
        stateResult.value[0]?.private_published_at,
      );
      const requested =
        context.req.query("board") === "private" ? "private" : "public";
      const board =
        requested === "private" && privatePublished ? "private" : "public";
      const language = context.req.query("language");
      const result = await database.query<LeaderboardRow[]>(
        `SELECT u.username, s.id AS submission_id, s.language,
                s.public_verdict, s.public_score_ns, s.private_verdict, s.private_score_ns,
                s.disqualified_reason, s.upload_started_at AS submitted_at
           FROM users u
           JOIN submissions s ON s.id = u.representative_submission_id
          WHERE s.public_verdict = 'accepted'
            AND (? IS NULL OR s.language = ?)
          ORDER BY ${board === "private" ? "s.private_score_ns IS NULL, s.private_score_ns" : "s.public_score_ns"} ASC,
                   s.upload_started_at ASC`,
        [language ?? null, language ?? null],
      );
      if (result.isErr()) throw result.error;
      let rank = 0;
      const ranked: LeaderboardEntry[] = [];
      const disqualified: LeaderboardEntry[] = [];
      for (const row of result.value) {
        const finalVerdict = row.disqualified_reason
          ? "disqualified"
          : board === "private"
            ? (row.private_verdict ?? "infrastructure_error")
            : row.public_verdict;
        const accepted = finalVerdict === "accepted";
        if (accepted) rank += 1;
        const entry: LeaderboardEntry = {
          rank: accepted ? rank : null,
          username: row.username,
          submissionId: row.submission_id,
          language: row.language,
          scoreNs:
            board === "private" ? row.private_score_ns : row.public_score_ns,
          verdict: finalVerdict,
          submittedAt: row.submitted_at.toISOString(),
          sourceAvailable: privatePublished,
        };
        (accepted ? ranked : disqualified).push(entry);
      }
      return context.json({ board, privatePublished, ranked, disqualified });
    })
    .get("/datasets", async (context) => {
      const result = await database.query<DatasetRow[]>(
        `SELECT contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
                uncompressed_bytes, compressed_sha256, uncompressed_sha256
           FROM dataset_releases WHERE contest_id = ? AND is_public = TRUE ORDER BY rows_count, kind`,
        [config.CONTEST_ID],
      );
      if (result.isErr()) throw result.error;
      return context.json({
        datasets: result.value.map((row) => ({
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
      });
    })
    .get("/datasets/:datasetId/:artifact/download", async (context) => {
      const artifact = context.req.param("artifact");
      if (artifact !== "input" && artifact !== "expected") {
        throw new AppError(
          "not_found",
          "dataset_not_found",
          "公開データが見つかりません",
        );
      }
      const result = await database.query<DatasetRow[]>(
        `SELECT contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
                uncompressed_bytes, compressed_sha256, uncompressed_sha256
           FROM dataset_releases
          WHERE contest_id = ? AND artifact_id = ? AND is_public = TRUE LIMIT 1`,
        [config.CONTEST_ID, `${context.req.param("datasetId")}-${artifact}`],
      );
      if (result.isErr()) throw result.error;
      const dataset = result.value[0];
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
      context.header("Cache-Control", "no-store");
      return context.redirect(signed.value, 302);
    })
    .post("/access-key", async (context) => {
      const user = requireHeaderUser(context);
      const issued = issueAccessKey();
      const result = await database.execute(
        `INSERT INTO api_tokens (username, token_hash, token_prefix)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), token_prefix = VALUES(token_prefix),
         created_at = CURRENT_TIMESTAMP(6), last_used_at = NULL`,
        [user.username, issued.hash, issued.prefix],
      );
      if (result.isErr()) throw result.error;
      return context.json(
        { accessKey: issued.token, prefix: issued.prefix },
        201,
      );
    })
    .delete("/access-key", async (context) => {
      const user = requireHeaderUser(context);
      const result = await database.execute(
        "DELETE FROM api_tokens WHERE username = ?",
        [user.username],
      );
      if (result.isErr()) throw result.error;
      return context.body(null, 204);
    })
    .post("/submissions", async (context) => {
      const user = requireUser(context);
      const reservation = await submissions.accept(
        user.username,
        context.env.incoming,
      );
      context.header("Location", `/api/v1/submissions/${reservation.id}`);
      return context.json(
        {
          id: reservation.id,
          status: "queued" as const,
          statusUrl: `/api/v1/submissions/${reservation.id}`,
          uploadStartedAt: reservation.uploadStartedAt,
        },
        202,
      );
    })
    .get("/submissions", async (context) => {
      const user = requireUser(context);
      const result = await database.query<SubmissionRow[]>(
        "SELECT * FROM submissions WHERE username = ? ORDER BY upload_started_at DESC LIMIT 100",
        [user.username],
      );
      if (result.isErr()) throw result.error;
      const privatePublished = await isPrivatePublished(database);
      return context.json({
        submissions: result.value.map((row) =>
          serializeSubmission(row, privatePublished),
        ),
      });
    })
    .get("/submissions/:id", async (context) => {
      const user = requireUser(context);
      const result = await database.query<SubmissionRow[]>(
        "SELECT * FROM submissions WHERE id = ? LIMIT 1",
        [context.req.param("id")],
      );
      if (result.isErr()) throw result.error;
      const row = result.value[0];
      if (!row)
        throw new AppError(
          "not_found",
          "submission_not_found",
          "提出が見つかりません",
        );
      if (row.username !== user.username && !user.isAdmin) {
        throw new AppError(
          "forbidden",
          "submission_forbidden",
          "この提出は閲覧できません",
        );
      }
      const privatePublished = await isPrivatePublished(database);
      return context.json({
        submission: serializeSubmission(row, privatePublished),
      });
    })
    .get("/submissions/:id/source", async (context) => {
      const user = context.get("authUser");
      const result = await database.query<
        (RowDataPacket & {
          username: string;
          representative_submission_id: string | null;
          filename: string;
          content: Buffer;
        })[]
      >(
        `SELECT s.username, u.representative_submission_id, ss.filename, ss.content
           FROM submissions s JOIN users u ON u.username = s.username
           JOIN submission_sources ss ON ss.submission_id = s.id WHERE s.id = ? LIMIT 1`,
        [context.req.param("id")],
      );
      if (result.isErr()) throw result.error;
      const row = result.value[0];
      if (!row)
        throw new AppError(
          "not_found",
          "source_not_found",
          "sourceが見つかりません",
        );
      const published = await isPrivatePublished(database);
      const publicSource =
        published &&
        row.representative_submission_id === context.req.param("id");
      if (
        !publicSource &&
        (!user || (user.username !== row.username && !user.isAdmin))
      ) {
        throw new AppError(
          "forbidden",
          "source_forbidden",
          "sourceはまだ公開されていません",
        );
      }
      context.header("Content-Type", "application/octet-stream");
      context.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      );
      context.header("X-Content-Type-Options", "nosniff");
      return context.body(new Uint8Array(row.content));
    })
    .get("/admin/submissions", async (context) => {
      requireAdmin(context);
      const result = await database.query<SubmissionRow[]>(
        "SELECT * FROM submissions ORDER BY upload_started_at DESC LIMIT 500",
      );
      if (result.isErr()) throw result.error;
      const published = await isPrivatePublished(database);
      return context.json({
        submissions: result.value.map((row) =>
          serializeSubmission(row, published),
        ),
      });
    })
    .post("/admin/submissions/:id/retry", async (context) => {
      const admin = requireAdmin(context);
      const result = await database.execute(
        "UPDATE submissions SET status = 'queued', infrastructure_error = NULL WHERE id = ? AND status = 'infrastructure_error'",
        [context.req.param("id")],
      );
      if (result.isErr()) throw result.error;
      if (
        !("affectedRows" in result.value) ||
        result.value.affectedRows !== 1
      ) {
        throw new AppError(
          "conflict",
          "retry_not_allowed",
          "再試行できるinfrastructure error提出ではありません",
        );
      }
      await audit(
        database,
        admin.username,
        "retry_submission",
        context.req.param("id"),
      );
      return context.json({ ok: true });
    })
    .post("/admin/submissions/:id/disqualify", async (context) => {
      const admin = requireAdmin(context);
      const body = await readJson<{ reason?: string }>(context);
      const reason = body.reason?.trim();
      if (!reason)
        throw new AppError(
          "bad_request",
          "reason_required",
          "失格理由を入力してください",
        );
      const result = await database.transaction(async (connection) => {
        const [rows] = await connection.query<
          (RowDataPacket & { status: string })[]
        >("SELECT status FROM submissions WHERE id = ? FOR UPDATE", [
          context.req.param("id"),
        ]);
        if (!rows[0]) {
          throw new AppError(
            "not_found",
            "submission_not_found",
            "提出が見つかりません",
          );
        }
        if (rows[0].status === "uploading" || rows[0].status === "running") {
          throw new AppError(
            "conflict",
            "submission_active",
            "uploadingまたはrunningの提出は完了後に失格化してください",
          );
        }
        await connection.execute(
          "UPDATE submissions SET disqualified_reason = ?, status = 'disqualified' WHERE id = ?",
          [reason.slice(0, 8192), context.req.param("id")],
        );
      });
      if (result.isErr()) throw result.error;
      await audit(
        database,
        admin.username,
        "disqualify_submission",
        context.req.param("id"),
        { reason },
      );
      return context.json({ ok: true });
    })
    .post("/admin/datasets/import", async (context) => {
      const admin = requireAdmin(context);
      const parsedManifest = datasetManifestSchema.safeParse(
        await readJson<unknown>(context),
      );
      if (!parsedManifest.success) {
        throw new AppError(
          "bad_request",
          "invalid_manifest",
          "dataset manifestが不正です",
          parsedManifest.error,
        );
      }
      const manifest = parsedManifest.data;
      if (manifest.contestId !== config.CONTEST_ID) {
        throw new AppError(
          "bad_request",
          "contest_id_mismatch",
          "manifestのcontest IDが一致しません",
        );
      }
      const result = await database.transaction(async (connection) => {
        await connection.execute(
          "DELETE FROM dataset_releases WHERE contest_id = ?",
          [config.CONTEST_ID],
        );
        for (const artifact of manifest.artifacts) {
          if (
            artifact.isPublic &&
            !artifact.objectKey.startsWith(
              `datasets/${config.CONTEST_ID}/public/`,
            )
          ) {
            throw new AppError(
              "bad_request",
              "invalid_public_object",
              "public object keyが不正です",
            );
          }
          await connection.execute(
            `INSERT INTO dataset_releases
             (contest_id, artifact_id, kind, label, object_key, rows_count, compressed_bytes,
              uncompressed_bytes, compressed_sha256, uncompressed_sha256, is_public,
              generator_revision, generated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              manifest.contestId,
              artifact.id,
              artifact.kind,
              artifact.label,
              artifact.objectKey,
              artifact.rows,
              artifact.compressedBytes,
              artifact.uncompressedBytes,
              artifact.compressedSha256,
              artifact.uncompressedSha256,
              artifact.isPublic,
              manifest.generatorRevision,
              new Date(manifest.generatedAt),
            ],
          );
        }
      });
      if (result.isErr()) throw result.error;
      await audit(
        database,
        admin.username,
        "import_dataset_manifest",
        manifest.contestId,
        {
          artifacts: manifest.artifacts.length,
        },
      );
      return context.json({ imported: manifest.artifacts.length });
    })
    .post("/admin/private/publish", async (context) => {
      const admin = requireAdmin(context);
      const result = await database.transaction(async (connection) => {
        await connection.query(
          "SELECT singleton_id FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
        );
        const [clockRows] = await connection.query<
          (RowDataPacket & { contest_ended: number })[]
        >("SELECT CURRENT_TIMESTAMP(6) > ? AS contest_ended", [
          config.CONTEST_END_AT,
        ]);
        if (!clockRows[0]?.contest_ended) {
          throw new AppError(
            "conflict",
            "contest_not_ended",
            "コンテスト終了前には公開できません",
          );
        }
        const [activeRows] = await connection.query<
          (RowDataPacket & { active_count: number })[]
        >(
          "SELECT COUNT(*) AS active_count FROM submissions WHERE status IN ('uploading', 'queued', 'running', 'infrastructure_error')",
        );
        if (Number(activeRows[0]?.active_count ?? 0) > 0) {
          throw new AppError(
            "conflict",
            "queue_not_drained",
            "未完了または要再試行の提出があります",
          );
        }
        await connection.execute(
          "UPDATE contest_state SET private_published_at = COALESCE(private_published_at, CURRENT_TIMESTAMP(6)) WHERE singleton_id = 1",
        );
        await connection.execute(
          `DELETE ss FROM submission_sources ss
            JOIN submissions s ON s.id = ss.submission_id
            JOIN users u ON u.username = s.username
           WHERE u.representative_submission_id IS NULL OR ss.submission_id <> u.representative_submission_id`,
        );
      });
      if (result.isErr()) throw result.error;
      await audit(
        database,
        admin.username,
        "publish_private_leaderboard",
        config.CONTEST_ID,
      );
      return context.json({ published: true });
    });

  return api;
}

export type ApiType = ReturnType<typeof createApiRoutes>;

export function createApp(dependencies: AppDependencies) {
  const app = new Hono<Env>();
  app.use("*", async (context, next) => {
    context.set(
      "requestId",
      context.req.header("x-request-id") ?? randomUUID(),
    );
    await next();
    context.header("X-Request-Id", context.get("requestId"));
  });
  app.use("*", secureHeaders());
  app.use("/api/*", authMiddleware(dependencies.database, dependencies.config));
  app.use("/api/*", async (context, next) => {
    const method = context.req.method;
    const user = context.get("authUser");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      user?.method === "header"
    ) {
      const origin = context.req.header("origin");
      if (origin !== dependencies.config.APP_ORIGIN) {
        throw new AppError(
          "forbidden",
          "invalid_origin",
          "Originが一致しません",
        );
      }
    }
    await next();
  });
  app.route("/api/v1", createApiRoutes(dependencies));
  app.notFound(async (context) => {
    if (context.req.path.startsWith("/api/"))
      return context.json(
        {
          error: {
            code: "not_found",
            message: "Not found",
            requestId: context.get("requestId"),
          },
        },
        404,
      );
    const response = await serveStatic({
      root: dependencies.config.STATIC_ROOT,
      path: "index.html",
    })(context, async () => undefined);
    return response ?? context.text("Frontend is not built", 404);
  });
  app.use("/*", serveStatic({ root: dependencies.config.STATIC_ROOT }));
  app.onError((error, context) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            "infrastructure",
            "internal_error",
            "Internal server error",
            error,
          );
    dependencies.logger.error("request failed", {
      requestId: context.get("requestId"),
      code: appError.code,
      error: error instanceof Error ? error.stack : String(error),
    });
    return context.json(
      {
        error: {
          code: appError.code,
          message: appError.message,
          requestId: context.get("requestId"),
        },
      },
      errorStatus(appError),
    );
  });
  return app;
}

function requireUser(context: AppContext): AuthUser {
  const user = context.get("authUser");
  if (!user)
    throw new AppError(
      "unauthorized",
      "authentication_required",
      "ログインまたはアクセスキーが必要です",
    );
  return user;
}

function requireHeaderUser(context: AppContext): AuthUser {
  const user = requireUser(context);
  if (user.method !== "header") {
    throw new AppError(
      "forbidden",
      "browser_auth_required",
      "ブラウザからログインしてください",
    );
  }
  return user;
}

function requireAdmin(context: AppContext): AuthUser {
  const user = requireHeaderUser(context);
  if (!user.isAdmin)
    throw new AppError("forbidden", "admin_required", "管理者権限が必要です");
  return user;
}

async function isPrivatePublished(database: Database): Promise<boolean> {
  const result = await database.query<StateRow[]>(
    "SELECT private_published_at FROM contest_state WHERE singleton_id = 1",
  );
  if (result.isErr()) throw result.error;
  return Boolean(result.value[0]?.private_published_at);
}

function serializeSubmission(row: SubmissionRow, privatePublished: boolean) {
  return {
    id: row.id,
    username: row.username,
    executionKind: row.execution_kind,
    language: row.language,
    sourceFilename: row.source_filename,
    artifactSha256: row.artifact_sha256,
    status: row.status,
    public: row.public_verdict
      ? {
          verdict: row.disqualified_reason
            ? "disqualified"
            : row.public_verdict,
          scoreNs: row.public_score_ns,
          error: row.public_error,
        }
      : null,
    ...(privatePublished
      ? {
          private: row.private_verdict
            ? { verdict: row.private_verdict, scoreNs: row.private_score_ns }
            : null,
        }
      : {}),
    infrastructureError: row.infrastructure_error,
    disqualifiedReason: row.disqualified_reason,
    uploadStartedAt: row.upload_started_at.toISOString(),
    queuedAt: row.queued_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

async function audit(
  database: Database,
  admin: string,
  action: string,
  target: string,
  detail?: Record<string, unknown>,
) {
  const result = await database.execute(
    "INSERT INTO admin_audit (admin_username, action, target_id, detail_json) VALUES (?, ?, ?, ?)",
    [admin, action, target, detail ? JSON.stringify(detail) : null],
  );
  if (result.isErr()) throw result.error;
}

async function readJson<T>(context: AppContext): Promise<T> {
  try {
    return await context.req.json<T>();
  } catch (cause) {
    throw new AppError(
      "bad_request",
      "invalid_json",
      "JSON request bodyが不正です",
      cause,
    );
  }
}
