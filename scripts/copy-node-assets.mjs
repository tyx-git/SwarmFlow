import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] ?? "dist");
mkdirSync(output, { recursive: true });

for (const directory of ["assets", "prompts", "skills"]) {
  const source = join(root, directory);
  const target = join(output, directory);
  // Build outputs are disposable. Remove the previous copy first so deleted
  // bundled assets cannot survive in dist after a rebuild.
  rmSync(target, { recursive: true, force: true });
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true });
  }
}

copyFileSync(join(root, "package.json"), join(output, "package.json"));
