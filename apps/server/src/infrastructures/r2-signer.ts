import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ResultAsync } from "neverthrow";

import { AppError } from "../utils/errors.js";
import type { Config } from "./config.js";

export type R2Signer = ReturnType<typeof createR2Signer>;

export function createR2Signer(config: Config) {
  const publicEndpoint =
    config.R2_ENDPOINT ??
    `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const createClient = (endpoint: string) =>
    new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: endpoint.startsWith("http://"),
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
  const publicClient = createClient(publicEndpoint);
  const internalClient = config.R2_INTERNAL_ENDPOINT
    ? createClient(config.R2_INTERNAL_ENDPOINT)
    : publicClient;

  return {
    verifyObject(objectKey: string) {
      return ResultAsync.fromPromise(
        internalClient
          .send(
            new HeadObjectCommand({
              Bucket: config.R2_BUCKET_NAME,
              Key: objectKey,
            }),
          )
          .then(() => undefined),
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
        getSignedUrl(
          publicClient,
          new GetObjectCommand({
            Bucket: config.R2_BUCKET_NAME,
            Key: objectKey,
            ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          }),
          { expiresIn: 15 * 60 },
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
