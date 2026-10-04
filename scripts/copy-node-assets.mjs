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

// jq 是随 Windows 发布包提供的工具，不属于 Node 依赖。
// 将它放在编译后的工具模块旁边，使普通 dist 和 SEA 运行时都能找到，
// 同时保留 src/tools 下的其他内容。
const intoolsSource = join(root, "src", "tools", "intools");
const intoolsTarget = join(output, "src", "tools", "intools");
rmSync(intoolsTarget, { recursive: true, force: true });
if (existsSync(intoolsSource)) {
  cpSync(intoolsSource, intoolsTarget, { recursive: true });
}

copyFileSync(join(root, "package.json"), join(output, "package.json"));
