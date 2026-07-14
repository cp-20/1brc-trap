import type { Database } from "../infrastructures/database.js";

export type AccountRepository = ReturnType<typeof createAccountRepository>;

export function createAccountRepository(database: Database) {
  return {
    issueAccessKey(username: string, hash: Buffer, prefix: string) {
      return database
        .execute(
          `INSERT INTO api_tokens (username, token_hash, token_prefix)
           VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), token_prefix = VALUES(token_prefix),
           created_at = CURRENT_TIMESTAMP(6), last_used_at = NULL`,
          [username, hash, prefix],
        )
        .map(() => undefined);
    },
    revokeAccessKey(username: string) {
      return database
        .execute("DELETE FROM api_tokens WHERE username = ?", [username])
        .map(() => undefined);
    },
  };
}
