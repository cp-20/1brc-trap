import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "../infrastructures/database.js";
import { apiTokens, users } from "../infrastructures/schema.js";

export type AccountRepository = ReturnType<typeof createAccountRepository>;

export function createAccountRepository(database: Database) {
  return {
    issueAccessKey(username: string, hash: Buffer, prefix: string) {
      return database
        .result(
          database.orm
            .insert(apiTokens)
            .values({
              username,
              token_hash: hash,
              token_prefix: prefix,
            })
            .onDuplicateKeyUpdate({
              set: {
                token_hash: hash,
                token_prefix: prefix,
                created_at: sql`CURRENT_TIMESTAMP(6)`,
                last_used_at: null,
              },
            }),
        )
        .map(() => undefined);
    },
    revokeAccessKey(username: string) {
      return database
        .result(
          database.orm
            .delete(apiTokens)
            .where(eq(apiTokens.username, username)),
        )
        .map(() => undefined);
    },
    token(hash: Buffer) {
      return database
        .result(
          database.orm
            .select({
              username: apiTokens.username,
              token_hash: apiTokens.token_hash,
            })
            .from(apiTokens)
            .where(eq(apiTokens.token_hash, hash))
            .limit(1),
        )
        .map((rows) => rows[0] ?? null);
    },
    touchToken(username: string) {
      return database
        .result(
          database.orm
            .update(apiTokens)
            .set({ last_used_at: sql`CURRENT_TIMESTAMP(6)` })
            .where(
              and(
                eq(apiTokens.username, username),
                or(
                  isNull(apiTokens.last_used_at),
                  lt(
                    apiTokens.last_used_at,
                    sql`CURRENT_TIMESTAMP(6) - INTERVAL 5 MINUTE`,
                  ),
                ),
              ),
            ),
        )
        .map(() => undefined);
    },
    ensureUser(username: string) {
      return database
        .result(database.orm.insert(users).ignore().values({ username }))
        .map(() => undefined);
    },
  };
}
