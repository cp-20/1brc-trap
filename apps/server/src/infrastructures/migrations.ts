import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { Config } from "./config.js";

const migrationLock = "1brc_schema_migrations";
const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function migrateDatabase(config: Config): Promise<string[]> {
  const connection = await mysql.createConnection({
    host: config.NS_MARIADB_HOSTNAME,
    port: config.NS_MARIADB_PORT,
    user: config.NS_MARIADB_USER,
    password: config.NS_MARIADB_PASSWORD,
    database: config.NS_MARIADB_DATABASE,
    multipleStatements: true,
    timezone: "Z",
  });

  try {
    const [lockRows] = await connection.query<
      (RowDataPacket & { acquired: number })[]
    >("SELECT GET_LOCK(?, 60) AS acquired", [migrationLock]);
    if (lockRows[0]?.acquired !== 1) {
      throw new Error("timed out waiting for the database migration lock");
    }

    try {
      await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
      const [appliedRows] = await connection.query<
        (RowDataPacket & { filename: string })[]
      >("SELECT filename FROM schema_migrations");
      const applied = new Set(appliedRows.map((row) => row.filename));
      const files = (await readdir(migrationsDirectory))
        .filter((filename) => /^\d+_.+\.sql$/.test(filename))
        .sort();
      const migrated: string[] = [];

      for (const filename of files) {
        if (applied.has(filename)) continue;
        await connection.query(
          await readFile(`${migrationsDirectory}/${filename}`, "utf8"),
        );
        await connection.execute(
          "INSERT INTO schema_migrations (filename) VALUES (?)",
          [filename],
        );
        migrated.push(filename);
      }
      return migrated;
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [migrationLock]);
    }
  } finally {
    await connection.end();
  }
}
