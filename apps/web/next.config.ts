import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin tracing to the monorepo root so a stray lockfile higher up isn't picked.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
