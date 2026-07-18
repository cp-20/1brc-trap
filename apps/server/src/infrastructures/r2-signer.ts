import { ResultAsync } from "neverthrow";

import { AppError } from "../utils/errors.js";
import type { Config } from "./config.js";

export type R2Signer = ReturnType<typeof createR2Signer>;

export function createR2Signer(config: Config) {
  const publicEndpoint =
    config.R2_ENDPOINT ??
    `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const createClient = (endpoint: string) => {
    const url = new URL(endpoint);
    const virtualHostedStyle = url.protocol === "https:";
    if (virtualHostedStyle) {
      url.hostname = `${config.R2_BUCKET_NAME}.${url.hostname}`;
    }
    return new Bun.S3Client({
      region: "auto",
      endpoint: url.toString(),
      virtualHostedStyle,
      bucket: config.R2_BUCKET_NAME,
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    });
  };
  const publicClient = createClient(publicEndpoint);
  const internalClient = config.R2_INTERNAL_ENDPOINT
    ? createClient(config.R2_INTERNAL_ENDPOINT)
    : publicClient;

  return {
    verifyObject(objectKey: string) {
      return ResultAsync.fromPromise(
        internalClient.stat(objectKey).then(() => undefined),
        (cause) =>
          new AppError(
            "infrastructure",
            "r2_object_unavailable",
            `R2上の公開データを確認できません: ${objectKey}`,
            cause,
          ),
      );
    },
    signDownload(objectKey: string, filename: string) {
      return ResultAsync.fromPromise(
        Promise.resolve().then(() =>
          publicClient.presign(objectKey, {
            expiresIn: 15 * 60,
            contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          }),
        ),
        (cause) =>
          new AppError(
            "infrastructure",
            "r2_signing_failed",
            "公開データのダウンロードURLを発行できません",
            cause,
          ),
      );
    },
  };
}
