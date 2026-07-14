import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/infrastructures/schema.ts",
  out: "./migrations",
});
