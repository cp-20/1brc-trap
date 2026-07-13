import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import Busboy from "busboy";
import type { ExecutionKind, Language } from "@1brc/contracts";
import {
  executionKindSchema,
  inferLanguage,
  sourceExtensions,
} from "@1brc/contracts";
import type { Config } from "../infrastructures/config.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";

const sourceLimit = 1024 * 1024;
const binaryLimit = 64 * 1024 * 1024;
const uploadTimeoutMs = 15 * 60 * 1000;

type ParsedUpload = {
  executionKind: ExecutionKind;
  language: Language;
  sourceFilename: string;
  source: Buffer;
  artifactPath: string;
  artifactSha256: string;
  cleanupDirectory: string;
};

export type SubmissionService = ReturnType<typeof createSubmissionService>;

export function createSubmissionService(
  repository: SubmissionRepository,
  runner: RunnerClient,
  config: Config,
) {
  async function discardReservation(id: string) {
    await runner.cleanup(id);
    await repository.discardUpload(id);
  }

  return {
    async accept(username: string, request: Request) {
      const reservation = await repository.reserve(username, config);
      let parsed: ParsedUpload | undefined;
      try {
        parsed = await parseMultipart(request, reservation.id);
        await validateUpload(parsed);
        await repository.storeSource(
          reservation.id,
          parsed.sourceFilename,
          createHash("sha256").update(parsed.source).digest("hex"),
          parsed.source,
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
        await repository.queueUpload(
          reservation.id,
          parsed.executionKind,
          parsed.language,
          parsed.sourceFilename,
          parsed.artifactSha256,
        );
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
        await discardReservation(reservation.id);
        throw appError;
      } finally {
        if (parsed)
          await rm(parsed.cleanupDirectory, { recursive: true, force: true });
      }
    },
  };
}

async function parseMultipart(
  request: Request,
  id: string,
): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data")) {
    throw new AppError(
      "bad_request",
      "multipart_required",
      "multipart/form-dataで提出してください",
    );
  }
  if (!request.body) {
    throw new AppError("bad_request", "empty_upload", "提出内容が空です");
  }
  const incoming = Readable.fromWeb(
    request.body as unknown as NodeReadableStream,
  );
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
      request.signal.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () =>
      finish(() =>
        reject(
          new AppError(
            "bad_request",
            "upload_aborted",
            "アップロードが切断されました",
          ),
        ),
      );
    request.signal.addEventListener("abort", onAbort, { once: true });
    incoming.once("error", (error) => finish(() => reject(error)));
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: Object.fromEntries(request.headers.entries()),
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
              "ソースコードまたは実行ファイル以外は指定できません",
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
                  "スクリプト言語では実装言語を指定しません",
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
                  "ソースコードが不足しているか、1 MiBを超えています",
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
                  "Nativeの実行ファイルが不足しているか、64 MiBを超えています",
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
                  "スクリプト言語では実行ファイルを指定しません",
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
      "ソースコードはUTF-8で提出してください",
      cause,
    );
  }
  if (upload.source.includes(0)) {
    throw new AppError(
      "bad_request",
      "source_contains_nul",
      "ソースコードにNULバイトを含められません",
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
      `${upload.language}のソースコード拡張子が不正です`,
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
