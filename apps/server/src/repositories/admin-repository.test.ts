import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createOrm, type Database } from "../infrastructures/database.js";
import { createAdminRepository } from "./admin-repository.js";

describe("private result publication", () => {
  it("公開状態だけを変更し、unpublish可能なように提出ソースを保持する", async () => {
    const { database, query } = publicationDatabase(0);
    const repository = createAdminRepository(database);

    const result = await repository.publishPrivateResults(
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(result.isOk()).toBe(true);
    const executedSql = query.mock.calls.map(([statement]) => sql(statement));
    expect(
      executedSql.some(
        (statement) =>
          statement.startsWith("update `contest_state`") &&
          statement.includes("`private_published_at`"),
      ),
    ).toBe(true);
    expect(executedSql.some((sql) => sql.includes("submission_sources"))).toBe(
      false,
    );
  });

  it("未完了の提出がある間は公開状態を変更しない", async () => {
    const { database, query } = publicationDatabase(1);
    const repository = createAdminRepository(database);

    const result = await repository.publishPrivateResults(
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(result.isErr() && result.error.code).toBe("queue_not_drained");
    expect(
      query.mock.calls.some(([statement]) =>
        sql(statement).startsWith("update `contest_state`"),
      ),
    ).toBe(false);
  });
});

function publicationDatabase(activeCount: number) {
  const query = vi.fn(async (statement: string | { sql: string }) => {
    const querySql = sql(statement);
    if (
      querySql.includes("`private_published_at`") &&
      querySql.includes("for update")
    ) {
      return [[[null]], []];
    }
    if (querySql.includes("from DUAL")) return [[[1]], []];
    if (querySql.includes("count(*)")) return [[[activeCount]], []];
    return [{ affectedRows: 1, insertId: 0 }, []];
  });
  const transaction = createOrm({ query } as never);
  const database = {
    transaction: <T>(
      operation: (
        transaction: never,
      ) => PromiseLike<import("neverthrow").Result<T, Error>>,
    ) => new ResultAsync(Promise.resolve(operation(transaction as never))),
  } as unknown as Database;
  return { database, query };
}

function sql(statement: string | { sql: string }) {
  return typeof statement === "string" ? statement : statement.sql;
}
