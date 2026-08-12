import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] ?? "dist");
mkdirSync(output, { recursive: true });

for (const directory of ["assets", "prompts", "skills"]) {
  const source = join(root, directory);
  if (existsSync(source)) {
    cpSync(source, join(output, directory), { recursive: true });
  }
}

copyFileSync(join(root, "package.json"), join(output, "package.json"));
