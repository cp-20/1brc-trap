import { describe, expect, it } from "vitest";

import type { Config } from "./config.js";
import { createR2Signer } from "./r2-signer.js";

describe("R2 signer", () => {
  it("Cloudflare R2ではvirtual-host形式で署名する", async () => {
    const url = await signedUrl("https://account.r2.cloudflarestorage.com");
    expect(url.hostname).toBe(
      "onebrc-datasets.account.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toBe("/datasets/contest/public/input.csv.zst");
  });

  it("ローカルのHTTP S3互換環境ではpath形式で署名する", async () => {
    const url = await signedUrl("http://localhost:9000");
    expect(url.host).toBe("localhost:9000");
    expect(url.pathname).toBe(
      "/onebrc-datasets/datasets/contest/public/input.csv.zst",
    );
  });

  it("内部接続先を分けてもダウンロードURLには公開接続先を使う", async () => {
    const url = await signedUrl("http://localhost:9000", "http://rustfs:9000");
    expect(url.host).toBe("localhost:9000");
  });
});

async function signedUrl(
  endpoint: string,
  internalEndpoint?: string,
): Promise<URL> {
  const signer = createR2Signer({
    R2_ACCOUNT_ID: "account",
    R2_BUCKET_NAME: "onebrc-datasets",
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    R2_ENDPOINT: endpoint,
    R2_INTERNAL_ENDPOINT: internalEndpoint,
  } as Config);
  const result = await signer.signDownload(
    "datasets/contest/public/input.csv.zst",
    "input.csv.zst",
  );
  if (result.isErr()) throw result.error;
  return new URL(result.value);
}
