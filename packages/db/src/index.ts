import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export * from "../generated/prisma/client";

export type Db = PrismaClient;

export function createDb(connectionString: string = process.env["DATABASE_URL"] ?? ""): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForDb = globalThis as unknown as { __agentWalletDb?: PrismaClient };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getDb(): PrismaClient {
  globalForDb.__agentWalletDb ??= createDb();
  return globalForDb.__agentWalletDb;
}
