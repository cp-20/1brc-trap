import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ResultAsync } from "neverthrow";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

export type R2Signer = ReturnType<typeof createR2Signer>;

export function createR2Signer(config: Config) {
  const endpoint =
    config.R2_ENDPOINT ??
    `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: Boolean(config.R2_ENDPOINT),
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });

  return {
    signDownload(objectKey: string, filename: string) {
      return ResultAsync.fromPromise(
        getSignedUrl(
          client,
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
            "Download URL could not be issued",
            cause,
          ),
      );
    },
  };
}
