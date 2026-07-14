import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../utils/errors.js";
import type { Config } from "./config.js";
import { createDatabase } from "./database.js";

const mocks = vi.hoisted(() => {
  const connection = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  return {
    connection,
    pool: {
      query: vi.fn(),
      execute: vi.fn(),
      getConnection: vi.fn(async () => connection),
      end: vi.fn(),
    },
  };
});

vi.mock("mysql2/promise", () => ({
  default: { createPool: () => mocks.pool },
}));

describe("database Result boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("業務エラーのResultを失わずにtransactionをrollbackする", async () => {
    const expected = new AppError("conflict", "conflict", "conflict");
    const database = createDatabase(databaseConfig);

    const result = await database.transaction(async () => err(expected));

    expect(result.isErr() && result.error).toBe(expected);
    expect(mocks.connection.rollback).toHaveBeenCalledOnce();
    expect(mocks.connection.commit).not.toHaveBeenCalled();
    expect(mocks.connection.release).toHaveBeenCalledOnce();
  });

  it("成功Resultのときだけtransactionをcommitする", async () => {
    const database = createDatabase(databaseConfig);

    const result = await database.transaction(async () => ok("stored"));

    expect(result.isOk() && result.value).toBe("stored");
    expect(mocks.connection.commit).toHaveBeenCalledOnce();
    expect(mocks.connection.rollback).not.toHaveBeenCalled();
  });

  it("driver例外をthrowせずdatabase_errorへ変換する", async () => {
    mocks.pool.query.mockRejectedValueOnce(new Error("connection reset"));
    const database = createDatabase(databaseConfig);

    const result = await database.ping();

    expect(result.isErr() && result.error.code).toBe("database_error");
  });
});

const databaseConfig = {
  NS_MARIADB_HOSTNAME: "localhost",
  NS_MARIADB_PORT: 3306,
  NS_MARIADB_USER: "user",
  NS_MARIADB_PASSWORD: "password",
  NS_MARIADB_DATABASE: "database",
} as Config;
