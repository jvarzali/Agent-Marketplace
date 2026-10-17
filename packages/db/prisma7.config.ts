import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma runs from packages/db; the monorepo keeps one .env at its root.
loadEnv({ path: [".env", "../../.env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx ../core/scripts/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
