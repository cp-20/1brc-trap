import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import Busboy from "busboy";
import type { IncomingMessage } from "node:http";
import type { ExecutionKind, Language } from "@1brc/contracts";
import {
  executionKindSchema,
  inferLanguage,
  sourceExtensions,
} from "@1brc/contracts";
import type { RowDataPacket } from "mysql2/promise";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AppError } from "./errors.js";
import type { RunnerClient } from "./runner-client.js";

const sourceLimit = 1024 * 1024;
const binaryLimit = 64 * 1024 * 1024;
const uploadTimeoutMs = 15 * 60 * 1000;

type Reservation = { id: string; uploadStartedAt: string };

type ParsedUpload = {
  executionKind: ExecutionKind;
  language: Language;
  sourceFilename: string;
  source: Buffer;
  artifactPath: string;
  artifactSha256: string;
  cleanupDirectory: string;
};

type ActiveRow = RowDataPacket & { active_count: number };
type ClockRow = RowDataPacket & { now: Date; is_open: number };

export type SubmissionService = ReturnType<typeof createSubmissionService>;

export function createSubmissionService(
  database: Database,
  runner: RunnerClient,
  config: Config,
) {
  async function reserve(username: string): Promise<Reservation> {
    const id = randomUUID();
    const result = await database.transaction(async (connection) => {
      await connection.query(
        "SELECT singleton_id FROM contest_state WHERE singleton_id = 1 FOR UPDATE",
      );
      await connection.execute(
        "INSERT IGNORE INTO users (username) VALUES (?)",
        [username],
      );
      await connection.query(
        "SELECT username FROM users WHERE username = ? FOR UPDATE",
        [username],
      );
      const [clockRows] = await connection.query<ClockRow[]>(
        "SELECT CURRENT_TIMESTAMP(6) AS now, CURRENT_TIMESTAMP(6) <= ? AS is_open",
        [config.CONTEST_END_AT],
      );
      const clock = clockRows[0];
      if (!clock?.is_open) {
        throw new AppError(
          "contest_closed",
          "contest_closed",
          "提出受付は終了しました",
        );
      }
      if (clock.now < config.CONTEST_START_AT) {
        throw new AppError(
          "conflict",
          "contest_not_started",
          "コンテストはまだ始まっていません",
        );
      }
      const [activeRows] = await connection.query<ActiveRow[]>(
        "SELECT COUNT(*) AS active_count FROM submissions WHERE username = ? AND status IN ('uploading', 'queued', 'running')",
        [username],
      );
      if (Number(activeRows[0]?.active_count ?? 0) > 0) {
        throw new AppError(
          "conflict",
          "active_submission",
          "アップロードまたは計測中の提出があります",
        );
      }
      await connection.execute(
        "INSERT INTO submissions (id, username, status, upload_started_at) VALUES (?, ?, 'uploading', ?)",
        [id, username, clock.now],
      );
      return { id, uploadStartedAt: clock.now.toISOString() };
    });
    if (result.isErr()) throw result.error;
    return result.value;
  }

  async function failReservation(id: string, reason: string) {
    await runner.cleanup(id);
    await database.execute(
      "UPDATE submissions SET status = 'rejected', public_error = ?, completed_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND status = 'uploading'",
      [reason.slice(0, 8192), id],
    );
    await database.execute(
      "DELETE FROM submission_sources WHERE submission_id = ?",
      [id],
    );
  }

  return {
    async accept(
      username: string,
      incoming: IncomingMessage,
    ): Promise<Reservation> {
      const reservation = await reserve(username);
      let parsed: ParsedUpload | undefined;
      try {
        parsed = await parseMultipart(incoming, reservation.id);
        await validateUpload(parsed);
        await database
          .execute(
            "INSERT INTO submission_sources (submission_id, filename, sha256, content) VALUES (?, ?, ?, ?)",
            [
              reservation.id,
              parsed.sourceFilename,
              createHash("sha256").update(parsed.source).digest("hex"),
              parsed.source,
            ],
          )
          .match(
            () => undefined,
            (error) => {
              throw error;
            },
          );
        await runner
          .upload(
            reservation.id,
            parsed.executionKind,
            parsed.artifactSha256,
            parsed.artifactPath,
          )
          .match(
            () => undefined,
            (error) => {
              throw error;
            },
          );
        const queued = await database
          .execute(
            `UPDATE submissions
             SET execution_kind = ?, language = ?, source_filename = ?, artifact_sha256 = ?,
                 status = 'queued', queued_at = CURRENT_TIMESTAMP(6)
           WHERE id = ? AND status = 'uploading'`,
            [
              parsed.executionKind,
              parsed.language,
              parsed.sourceFilename,
              parsed.artifactSha256,
              reservation.id,
            ],
          )
          .match(
            (value) => value,
            (error) => {
              throw error;
            },
          );
        if (!("affectedRows" in queued) || queued.affectedRows !== 1) {
          throw new AppError(
            "conflict",
            "upload_expired",
            "アップロードの受付期限を超えました",
          );
        }
        return reservation;
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError(
                "bad_request",
                "invalid_upload",
                error instanceof Error ? error.message : "Invalid upload",
                error,
              );
        await failReservation(reservation.id, appError.message);
        throw appError;
      } finally {
        if (parsed)
          await rm(parsed.cleanupDirectory, { recursive: true, force: true });
      }
    },
    async cleanupStaleUploads() {
      return database.execute(
        `UPDATE submissions
            SET status = 'rejected', public_error = 'upload timeout', completed_at = CURRENT_TIMESTAMP(6)
          WHERE status = 'uploading' AND upload_started_at < CURRENT_TIMESTAMP(6) - INTERVAL 15 MINUTE`,
      );
    },
  };
}

async function parseMultipart(
  incoming: IncomingMessage,
  id: string,
): Promise<ParsedUpload> {
  const contentType = incoming.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    throw new AppError(
      "bad_request",
      "multipart_required",
      "multipart/form-dataで提出してください",
    );
  }
  const directory = join(tmpdir(), `1brc-upload-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binaryPath = join(directory, "binary");
  const sourcePath = join(directory, "source");

  return await new Promise<ParsedUpload>((resolve, reject) => {
    const fields = new Map<string, string>();
    const files = new Map<
      string,
      {
        path: string;
        filename: string;
        truncated: boolean;
        digest: ReturnType<typeof createHash>;
      }
    >();
    const pending: Promise<void>[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      incoming.destroy(new Error("upload timeout"));
      reject(
        new AppError(
          "bad_request",
          "upload_timeout",
          "アップロードは15分以内に完了してください",
        ),
      );
    }, uploadTimeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    incoming.once("aborted", () =>
      finish(() =>
        reject(
          new AppError(
            "bad_request",
            "upload_aborted",
            "アップロードが切断されました",
          ),
        ),
      ),
    );
    incoming.once("error", (error) => finish(() => reject(error)));
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: incoming.headers,
        defParamCharset: "utf8",
        limits: {
          fields: 4,
          files: 2,
          parts: 6,
          fieldNameSize: 64,
          fieldSize: 64,
          fileSize: binaryLimit,
        },
      });
    } catch (error) {
      clearTimeout(timer);
      return reject(error);
    }

    parser.on("field", (name, value) => {
      if (
        (name !== "executionKind" && name !== "language") ||
        fields.has(name)
      ) {
        finish(() =>
          reject(
            new AppError(
              "bad_request",
              "invalid_metadata",
              "提出metadataが不正です",
            ),
          ),
        );
        return;
      }
      fields.set(name, value);
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "source" && name !== "binary") {
        stream.resume();
        finish(() =>
          reject(
            new AppError(
              "bad_request",
              "unexpected_file",
              "sourceまたはbinary以外のfileは指定できません",
            ),
          ),
        );
        return;
      }
      if (files.has(name)) {
        stream.resume();
        finish(() =>
          reject(
            new AppError(
              "bad_request",
              "duplicate_file",
              `${name}は1個だけ指定できます`,
            ),
          ),
        );
        return;
      }
      let filename: string;
      try {
        filename = sanitizeFilename(info.filename);
      } catch (error) {
        stream.resume();
        finish(() => reject(error));
        return;
      }
      const path = name === "source" ? sourcePath : binaryPath;
      const limit = name === "source" ? sourceLimit : binaryLimit;
      let bytes = 0;
      let truncated = false;
      const digest = createHash("sha256");
      const output = createWriteStream(path, {
        mode: name === "binary" ? 0o700 : 0o600,
      });
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limit) {
            truncated = true;
            callback();
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      stream.on("limit", () => (truncated = true));
      const done = new Promise<void>((resolveFile, rejectFile) => {
        stream.once("error", rejectFile);
        limiter.once("error", rejectFile);
        output.once("error", rejectFile);
        output.once("close", resolveFile);
      });
      pending.push(done);
      files.set(name, { path, filename, truncated, digest });
      stream.pipe(limiter).pipe(output);
      stream.on("end", () => {
        const entry = files.get(name);
        if (entry) entry.truncated = truncated;
      });
    });
    for (const event of ["fieldsLimit", "filesLimit", "partsLimit"] as const) {
      parser.once(event, () =>
        finish(() =>
          reject(
            new AppError(
              "bad_request",
              "multipart_limit",
              "multipartのpart数が上限を超えています",
            ),
          ),
        ),
      );
    }
    parser.once("error", (error) => finish(() => reject(error)));
    parser.once("close", () => {
      void Promise.all(pending)
        .then(async () => {
          if (settled) return;
          const kindResult = executionKindSchema.safeParse(
            fields.get("executionKind"),
          );
          if (!kindResult.success) {
            return finish(() =>
              reject(
                new AppError(
                  "bad_request",
                  "invalid_execution_kind",
                  "実行形式が不正です",
                ),
              ),
            );
          }
          const kind = kindResult.data;
          if (kind !== "native" && fields.has("language")) {
            return finish(() =>
              reject(
                new AppError(
                  "bad_request",
                  "unexpected_language",
                  "runtime言語ではlanguageを指定しません",
                ),
              ),
            );
          }
          const language = inferLanguage(kind, fields.get("language"));
          const sourceFile = files.get("source");
          const binaryFile = files.get("binary");
          if (!language || !sourceFile || sourceFile.truncated) {
            return finish(() =>
              reject(
                new AppError(
                  "bad_request",
                  "invalid_source",
                  "sourceが不足または1MiBを超えています",
                ),
              ),
            );
          }
          if (kind === "native" && (!binaryFile || binaryFile.truncated)) {
            return finish(() =>
              reject(
                new AppError(
                  "bad_request",
                  "invalid_binary",
                  "Native binaryが不足または64MiBを超えています",
                ),
              ),
            );
          }
          if (kind !== "native" && binaryFile) {
            return finish(() =>
              reject(
                new AppError(
                  "bad_request",
                  "unexpected_binary",
                  "runtime言語ではbinaryを指定しません",
                ),
              ),
            );
          }
          const source = await readFile(sourceFile.path);
          const artifactPath =
            kind === "native" ? binaryFile!.path : sourceFile.path;
          const artifactSha256 =
            kind === "native"
              ? binaryFile!.digest.digest("hex")
              : sourceFile.digest.digest("hex");
          finish(() =>
            resolve({
              executionKind: kind,
              language,
              sourceFilename: sourceFile.filename,
              source,
              artifactPath,
              artifactSha256,
              cleanupDirectory: directory,
            }),
          );
        })
        .catch((error) => finish(() => reject(error)));
    });
    incoming.pipe(parser);
  }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
}

async function validateUpload(upload: ParsedUpload) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(upload.source);
  } catch (cause) {
    throw new AppError(
      "bad_request",
      "source_not_utf8",
      "sourceはUTF-8で提出してください",
      cause,
    );
  }
  if (upload.source.includes(0)) {
    throw new AppError(
      "bad_request",
      "source_contains_nul",
      "sourceにNUL byteを含められません",
    );
  }
  const extensions = sourceExtensions[upload.language];
  if (
    extensions.length > 0 &&
    !extensions.includes(extname(upload.sourceFilename).toLowerCase())
  ) {
    throw new AppError(
      "bad_request",
      "invalid_source_extension",
      `${upload.language}のsource拡張子が不正です`,
    );
  }
  if (upload.executionKind === "native") {
    const handle = await open(upload.artifactPath, "r");
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const valid =
        bytesRead === header.length &&
        header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === 0x3e;
      if (!valid)
        throw new AppError(
          "bad_request",
          "invalid_elf",
          "Ubuntu 26.04 x86_64 ELFを提出してください",
        );
    } finally {
      await handle.close();
    }
  }
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base || base.length > 255 || /[\u0000-\u001f\u007f]/.test(base)) {
    throw new AppError(
      "bad_request",
      "invalid_filename",
      "ファイル名が不正です",
    );
  }
  return base;
}
