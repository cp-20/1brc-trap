import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

export function issueAccessKey(): {
  token: string;
  hash: Buffer;
  prefix: string;
} {
  const token = `1brc_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 13) };
}
