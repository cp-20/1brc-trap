import mysql, {
  type Connection,
  type Pool,
  type PoolConnection,
} from "mysql2/promise";
import { sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Result } from "neverthrow";
import { ResultAsync } from "neverthrow";
import type { Config } from "./config.js";
import * as schema from "./schema.js";
import { AppError } from "../utils/errors.js";

export type Database = ReturnType<typeof createDatabase>;
export type Orm = MySql2Database<typeof schema>;

export function createOrm(connection: Pool | PoolConnection | Connection): Orm {
  return drizzle(connection, { schema, mode: "default" });
}

export function createDatabase(config: Config) {
  const pool = mysql.createPool({
    host: config.NS_MARIADB_HOSTNAME,
    port: config.NS_MARIADB_PORT,
    user: config.NS_MARIADB_USER,
    password: config.NS_MARIADB_PASSWORD,
    database: config.NS_MARIADB_DATABASE,
    connectionLimit: 10,
    timezone: "Z",
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: "utf8mb4",
  });
  const orm = createOrm(pool);
  const result = <T>(operation: PromiseLike<T>) =>
    ResultAsync.fromPromise(
      operation,
      (cause) =>
        new AppError(
          "infrastructure",
          "database_error",
          "Database operation failed",
          cause,
        ),
    );

  return {
    pool,
    orm,
    result,
    ping: () => result(orm.execute(sql`SELECT 1`)).map(() => undefined),
    transaction<T>(
      operation: (transaction: Orm) => PromiseLike<Result<T, AppError>>,
    ) {
      return ResultAsync.fromPromise(
        withTransaction(pool, operation),
        (cause) =>
          cause instanceof AppError
            ? cause
            : new AppError(
                "infrastructure",
                "database_error",
                "Database transaction failed",
                cause,
              ),
      ).andThen((result) => result);
    },
    close: () => pool.end(),
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (transaction: Orm) => PromiseLike<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(createOrm(connection));
    if (result.isErr()) {
      await connection.rollback();
      return result;
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
