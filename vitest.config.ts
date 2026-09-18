import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

function resolveTypeScriptSource() {
  return {
    name: "resolve-typescript-source",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;

      const base = resolve(dirname(importer), source.slice(0, -3));
      for (const extension of [".ts", ".tsx"]) {
        const candidate = `${base}${extension}`;
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveTypeScriptSource()],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/node-runtime.test.ts", ".history/**", "external/**", "dist/**", "node_modules/**"],
  },
});
