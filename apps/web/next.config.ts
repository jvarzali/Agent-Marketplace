import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets a one-off check build elsewhere without clobbering a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin tracing to the monorepo root so a stray lockfile higher up isn't picked.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
