import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../infrastructures/config.js";
import { createOrm, type Database } from "../infrastructures/database.js";
import { createSubmissionRepository } from "./submission-repository.js";

describe("submission reservation", () => {
  it("コンテスト期間内かつactiveな提出がない場合だけuploadingを作成する", async () => {
    const { database, query } = reservationDatabase({
      now: new Date("2026-01-15T00:00:00Z"),
      isOpen: 1,
      activeCount: 0,
    });
    const repository = createSubmissionRepository(database);

    const result = await repository.reserve("user", contestConfig);

    expect(result.isOk()).toBe(true);
    expect(
      query.mock.calls.some(([statement]) =>
        sql(statement).startsWith("insert into `submissions`"),
      ),
    ).toBe(true);
  });

  it("終了後は提出行を作成せずcontest_closedを返す", async () => {
    const { database, query } = reservationDatabase({
      now: new Date("2026-02-02T00:00:00Z"),
      isOpen: 0,
      activeCount: 0,
    });
    const repository = createSubmissionRepository(database);

    const result = await repository.reserve("user", contestConfig);

    expect(result.isErr() && result.error.code).toBe("contest_closed");
    expect(
      query.mock.calls.some(([statement]) =>
        sql(statement).startsWith("insert into `submissions`"),
      ),
    ).toBe(false);
  });

  it("計測中の提出があるユーザーには二重提出を許可しない", async () => {
    const { database, query } = reservationDatabase({
      now: new Date("2026-01-15T00:00:00Z"),
      isOpen: 1,
      activeCount: 1,
    });
    const repository = createSubmissionRepository(database);

    const result = await repository.reserve("user", contestConfig);

    expect(result.isErr() && result.error.code).toBe("active_submission");
    expect(
      query.mock.calls.some(([statement]) =>
        sql(statement).startsWith("insert into `submissions`"),
      ),
    ).toBe(false);
  });
});

function reservationDatabase(options: {
  now: Date;
  isOpen: number;
  activeCount: number;
}) {
  const query = vi.fn(async (statement: string | { sql: string }) => {
    const querySql = sql(statement).toLowerCase();
    if (querySql.includes("from `contest_state`")) {
      return [[[1]], []];
    }
    if (querySql.includes("from `users`")) {
      return [[["user"]], []];
    }
    if (querySql.includes("from dual")) {
      return [
        [
          [
            options.now.toISOString().replace("T", " ").replace("Z", ""),
            options.isOpen,
          ],
        ],
        [],
      ];
    }
    if (querySql.includes("count(*)")) {
      return [[[options.activeCount]], []];
    }
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

const contestConfig = {
  CONTEST_START_AT: new Date("2026-01-01T00:00:00Z"),
  CONTEST_END_AT: new Date("2026-02-01T00:00:00Z"),
} as Config;
