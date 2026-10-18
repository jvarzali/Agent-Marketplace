import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** Follow every runtime (non-type) relative import from a file; collect bare specifiers. */
function runtimeImports(file: string, seen = new Set<string>(), bare = new Set<string>()) {
  if (seen.has(file)) return bare;
  seen.add(file);
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
    const spec = m[1]!;
    if (spec.startsWith(".")) runtimeImports(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`), seen, bare);
    else bare.add(spec);
  }
  return bare;
}

describe("@paysafe/core/pure", () => {
  it("is browser-safe: no Node built-ins, database or provider SDKs at runtime", () => {
    const deps = [...runtimeImports(resolve(src, "pure.ts"))];
    expect(deps.filter((d) => d.startsWith("node:") || d.startsWith("@paysafe/") || ["stripe", "web-push", "pg"].includes(d))).toEqual([]);
  });
});
