import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { loadConfig } from "./config.js";

const config = loadConfig();
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
  const migrationPath = fileURLToPath(
    new URL("../migrations/001_initial.sql", import.meta.url),
  );
  await connection.query(await readFile(migrationPath, "utf8"));
  process.stdout.write("MariaDB migration completed\n");
} finally {
  await connection.end();
}
