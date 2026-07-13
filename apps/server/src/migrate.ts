import { loadConfig } from "./infrastructures/config.js";
import { migrateDatabase } from "./infrastructures/migrations.js";

const config = loadConfig();
const migrated = await migrateDatabase(config);
process.stdout.write(
  migrated.length > 0
    ? `MariaDB migrations applied: ${migrated.join(", ")}\n`
    : "MariaDB schema is up to date\n",
);
