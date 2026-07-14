import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

import type { Config } from "./config.js";
import { createOrm } from "./database.js";

const migrationLock = "1brc_schema_migrations";
const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function migrateDatabase(config: Config): Promise<void> {
  const connection = await mysql.createConnection({
    host: config.NS_MARIADB_HOSTNAME,
    port: config.NS_MARIADB_PORT,
    user: config.NS_MARIADB_USER,
    password: config.NS_MARIADB_PASSWORD,
    database: config.NS_MARIADB_DATABASE,
    timezone: "Z",
  });
  const database = createOrm(connection);

  try {
    const [lock] = await database
      .select({ acquired: sql<number>`GET_LOCK(${migrationLock}, 60)` })
      .from(sql`DUAL`);
    if (lock?.acquired !== 1) {
      throw new Error("timed out waiting for the database migration lock");
    }

    try {
      await migrate(database, { migrationsFolder: migrationsDirectory });
    } finally {
      await database
        .select({ released: sql<number>`RELEASE_LOCK(${migrationLock})` })
        .from(sql`DUAL`);
    }
  } finally {
    await connection.end();
  }
}
