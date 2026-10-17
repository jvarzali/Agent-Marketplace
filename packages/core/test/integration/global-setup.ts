import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://postgres@localhost:54329/agent_wallet_test";

/** Recreate the test schema from migrations once per run. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Integration tests need Postgres at ${TEST_DATABASE_URL} (run ./scripts/local-db.sh start or set TEST_DATABASE_URL): ${String(e)}`);
  }
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  const dbPkg = fileURLToPath(new URL("../../../db", import.meta.url));
  execSync("npx prisma migrate deploy", { cwd: dbPkg, env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: "pipe" });
}
