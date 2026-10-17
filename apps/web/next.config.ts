import path from "node:path";
import type { NextConfig } from "next";

const root = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets a one-off check build elsewhere without clobbering a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin tracing to the monorepo root so a stray lockfile higher up isn't picked.
  outputFileTracingRoot: root,
  // The backend packages ship TypeScript source.
  transpilePackages: ["@agent-wallet/core", "@agent-wallet/db", "@agent-wallet/api", "@agent-wallet/mcp"],
  // Keep the database driver out of the bundle.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};

export default nextConfig;
