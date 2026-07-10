import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { ResultAsync } from "neverthrow";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

export type Database = ReturnType<typeof createDatabase>;

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

  return {
    pool,
    query<T extends RowDataPacket[]>(
      sql: string,
      values: readonly unknown[] = [],
    ) {
      return ResultAsync.fromPromise(
        pool.query<T>(sql, [...values]).then(([rows]) => rows),
        (cause) =>
          new AppError(
            "infrastructure",
            "database_error",
            "Database operation failed",
            cause,
          ),
      );
    },
    execute(sql: string, values: readonly unknown[] = []) {
      return ResultAsync.fromPromise(
        pool.execute(sql, [...values] as never[]).then(([result]) => result),
        (cause) =>
          new AppError(
            "infrastructure",
            "database_error",
            "Database operation failed",
            cause,
          ),
      );
    },
    transaction<T>(operation: (connection: PoolConnection) => Promise<T>) {
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
      );
    },
    close: () => pool.end(),
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
