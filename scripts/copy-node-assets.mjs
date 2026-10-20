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

// 随包分发的原生工具。curl/upx 等未引用资产不进入产物，避免 release 白白变大。
const NATIVE_TOOL_DIRS = ["jq", "fd", "ripgrep"];
const intoolsSource = join(root, "src", "tools", "intools");
const intoolsTarget = join(output, "src", "tools", "intools");
rmSync(intoolsTarget, { recursive: true, force: true });
mkdirSync(intoolsTarget, { recursive: true });
for (const name of NATIVE_TOOL_DIRS) {
  const source = join(intoolsSource, name);
  if (!existsSync(source)) {
    console.warn(`Native tool '${name}' not found at ${source}.`);
    continue;
  }
  cpSync(source, join(intoolsTarget, name), { recursive: true });
}

copyFileSync(join(root, "package.json"), join(output, "package.json"));
