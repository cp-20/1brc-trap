import { loadConfig } from "./infrastructures/config.js";
import { migrateDatabase } from "./infrastructures/migrations.js";

const config = loadConfig();
await migrateDatabase(config);
process.stdout.write("MariaDB schema is up to date\n");
