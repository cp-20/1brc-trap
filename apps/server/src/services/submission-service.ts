import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ExecutionKind, Language } from "@1brc/domain";
import {
  executionKindSchema,
  inferLanguage,
  submissionPolicy,
  sourceExtensions,
} from "@1brc/domain";
import {
  FormDataParseError,
  MaxFilesExceededError,
  MaxFileSizeExceededError,
  MaxHeaderSizeExceededError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
  parseFormData,
  type FileUpload,
} from "@remix-run/form-data-parser";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

import type { Config } from "../infrastructures/config.js";
import type { RunnerClient } from "../infrastructures/runner-client.js";
import type { SubmissionRepository } from "../repositories/submission-repository.js";
import { AppError } from "../utils/errors.js";

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
  function removeTemporaryDirectory(directory: string | undefined) {
    return directory
      ? ResultAsync.fromPromise(
          rm(directory, { recursive: true, force: true }),
          (cause) =>
            new AppError(
              "infrastructure",
              "upload_cleanup_failed",
              "一時ファイルを削除できませんでした",
              cause,
            ),
        )
      : okAsync(undefined);
  }

  function ignoreFailure(result: ResultAsync<unknown, AppError>) {
    return result.map(() => undefined).orElse(() => okAsync(undefined));
  }

  function discardReservation(
    id: string,
    directory: string | undefined,
    error: AppError,
  ) {
    return ignoreFailure(runner.cleanup(id))
      .andThen(() => ignoreFailure(repository.discardUpload(id)))
      .andThen(() => ignoreFailure(removeTemporaryDirectory(directory)))
      .andThen(() => errAsync(error));
  }

  return {
    accept(username: string, request: Request) {
      return repository.reserve(username, config).andThen((reservation) => {
        let cleanupDirectory: string | undefined;
        return ResultAsync.fromPromise(
          parseMultipart(request, reservation.id),
          uploadError,
        )
          .andThen((parsed) => {
            cleanupDirectory = parsed.cleanupDirectory;
            return ResultAsync.fromPromise(
              validateUpload(parsed),
              uploadError,
            ).map(() => parsed);
          })
          .andThen((parsed) =>
            repository
              .storeSource(
                reservation.id,
                parsed.sourceFilename,
                createHash("sha256").update(parsed.source).digest("hex"),
                parsed.source,
              )
              .map(() => parsed),
          )
          .andThen((parsed) =>
            runner
              .upload(
                reservation.id,
                parsed.executionKind,
                parsed.artifactSha256,
                parsed.artifactPath,
              )
              .map(() => parsed),
          )
          .andThen((parsed) =>
            repository
              .queueUpload(
                reservation.id,
                parsed.executionKind,
                parsed.language,
                parsed.sourceFilename,
                parsed.artifactSha256,
              )
              .map(() => reservation),
          )
          .andThen((accepted) =>
            ignoreFailure(removeTemporaryDirectory(cleanupDirectory)).map(
              () => accepted,
            ),
          )
          .orElse((error) =>
            discardReservation(reservation.id, cleanupDirectory, error),
          );
      });
    },
  };
}

function uploadError(cause: unknown) {
  return cause instanceof AppError
    ? cause
    : new AppError(
        "bad_request",
        "invalid_upload",
        cause instanceof Error ? cause.message : "Invalid upload",
        cause,
      );
}

async function parseMultipart(
  request: Request,
  id: string,
): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type");
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
    "multipart/form-data"
  ) {
    throw new AppError(
      "bad_request",
      "multipart_required",
      "multipart/form-dataで提出してください",
    );
  }
  if (!request.body) {
    throw new AppError("bad_request", "empty_upload", "提出内容が空です");
  }
  const directory = join(tmpdir(), `1brc-upload-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = new Map<
    "source" | "binary",
    {
      path: string;
      filename: string;
      digest: ReturnType<typeof createHash>;
    }
  >();
  const timeout = AbortSignal.timeout(submissionPolicy.uploadTimeoutMs);
  const completed = new AbortController();

  try {
    const signal = AbortSignal.any([request.signal, timeout, completed.signal]);
    const body = request.body.pipeThrough(new TransformStream(), { signal });
    const streamingRequest = new Request(request, {
      body,
      signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const form = await parseFormData(
      streamingRequest,
      {
        maxFiles: 2,
        maxParts: 4,
        maxHeaderSize: 4 * 1024,
        maxFileSize: submissionPolicy.binaryLimitBytes,
        maxTotalSize:
          submissionPolicy.sourceLimitBytes +
          submissionPolicy.binaryLimitBytes +
          128,
      },
      (file) => storeUpload(file, directory, files, signal),
    );
    validateFormShape(form);
    const kindResult = executionKindSchema.safeParse(form.get("executionKind"));
    if (!kindResult.success) {
      throw new AppError(
        "bad_request",
        "invalid_execution_kind",
        "実行形式が不正です",
      );
    }
    const kind = kindResult.data;
    if (kind !== "native" && form.has("language")) {
      throw new AppError(
        "bad_request",
        "unexpected_language",
        "スクリプト言語では実装言語を指定しません",
      );
    }
    const requestedLanguage = form.get("language");
    const language = inferLanguage(
      kind,
      typeof requestedLanguage === "string" ? requestedLanguage : undefined,
    );
    const sourceFile = files.get("source");
    const binaryFile = files.get("binary");
    if (!language || !sourceFile) {
      throw invalidFile("source");
    }
    if (kind === "native" && !binaryFile) {
      throw invalidFile("binary");
    }
    if (kind !== "native" && binaryFile) {
      throw new AppError(
        "bad_request",
        "unexpected_binary",
        "スクリプト言語では実行ファイルを指定しません",
      );
    }
    const source = await readFile(sourceFile.path);
    const artifact = kind === "native" ? binaryFile! : sourceFile;
    return {
      executionKind: kind,
      language,
      sourceFilename: sourceFile.filename,
      source,
      artifactPath: artifact.path,
      artifactSha256: artifact.digest.digest("hex"),
      cleanupDirectory: directory,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (timeout.aborted) {
      throw new AppError(
        "bad_request",
        "upload_timeout",
        "アップロードは15分以内に完了してください",
      );
    }
    if (request.signal.aborted) {
      throw new AppError(
        "bad_request",
        "upload_aborted",
        "アップロードが切断されました",
      );
    }
    if (error instanceof MaxFileSizeExceededError) {
      throw invalidFile("binary");
    }
    if (
      error instanceof MaxFilesExceededError ||
      error instanceof MaxHeaderSizeExceededError ||
      error instanceof MaxPartsExceededError ||
      error instanceof MaxTotalSizeExceededError
    ) {
      throw new AppError(
        "bad_request",
        "multipart_limit",
        "multipartの上限を超えています",
        error,
      );
    }
    if (error instanceof FormDataParseError) {
      throw new AppError(
        "bad_request",
        "invalid_upload",
        "multipartが不正です",
        error,
      );
    }
    throw error;
  } finally {
    completed.abort();
  }
}

async function storeUpload(
  file: FileUpload,
  directory: string,
  files: Map<
    "source" | "binary",
    {
      path: string;
      filename: string;
      digest: ReturnType<typeof createHash>;
    }
  >,
  signal: AbortSignal,
) {
  if (file.fieldName !== "source" && file.fieldName !== "binary") {
    throw new AppError(
      "bad_request",
      "unexpected_file",
      "ソースコードまたは実行ファイル以外は指定できません",
    );
  }
  const fieldName = file.fieldName;
  if (files.has(fieldName)) {
    throw new AppError(
      "bad_request",
      "duplicate_file",
      `${fieldName}は1個だけ指定できます`,
    );
  }
  const filename = sanitizeFilename(file.name);
  const path = join(directory, fieldName);
  const limit =
    fieldName === "source"
      ? submissionPolicy.sourceLimitBytes
      : submissionPolicy.binaryLimitBytes;
  const digest = createHash("sha256");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) return callback(invalidFile(fieldName));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(file.stream() as unknown as NodeReadableStream),
    limiter,
    createWriteStream(path, {
      mode: fieldName === "binary" ? 0o700 : 0o600,
    }),
    { signal },
  );
  files.set(fieldName, { path, filename, digest });
  return path;
}

function validateFormShape(form: FormData) {
  const allowed = new Set(["executionKind", "language", "source", "binary"]);
  const entries = [...form.entries()];
  if (
    entries.some(
      ([name, value]) =>
        !allowed.has(name) || (typeof value === "string" && value.length > 64),
    ) ||
    form.getAll("executionKind").length !== 1 ||
    form.getAll("language").length > 1 ||
    form.getAll("source").length !== 1 ||
    form.getAll("binary").length > 1
  ) {
    throw new AppError(
      "bad_request",
      "invalid_metadata",
      "提出metadataが不正です",
    );
  }
}

function invalidFile(file: "source" | "binary") {
  return new AppError(
    "bad_request",
    file === "source" ? "invalid_source" : "invalid_binary",
    file === "source"
      ? "ソースコードが不足しているか、1 MiBを超えています"
      : "Nativeの実行ファイルが不足しているか、64 MiBを超えています",
  );
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
  if (!base || base.length > 255 || /[\u0000-\u001F\u007F]/.test(base)) {
    throw new AppError(
      "bad_request",
      "invalid_filename",
      "ファイル名が不正です",
    );
  }
  return base;
}
