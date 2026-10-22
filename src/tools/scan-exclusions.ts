/**
 * 文件系统扫描的默认跳过集合 — glob、grep、list_dir 和 file-attach 共用。
 *
 * 单一真实来源：
 *  - EXCLUDE_DIRS    — 文件系统工具默认跳过的目录
 *  - isHiddenName    — 点前缀条目的遍历跳过判定
 *  - isExcludedDirName — 仅目录的跳过判定
 */

// ------------------------------------------------------------------
// 默认跳过集合 — glob、grep、list_dir 和 file-attach 使用
// ------------------------------------------------------------------

/**
 * 读取/搜索工具默认跳过的目录。
 *
 * 大致遵循跨生态系统的 `.gitignore` 常见模式
 *（Node、Python、Rust、Go、Java、.NET、前端工具链）。
 *
 * 当用户明确询问时，工具仍可能进入这些目录
 *（例如通过将目录作为 `path` 参数传递）。
 */
export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  // 版本控制
  ".git", ".hg", ".svn",
  // Node.js / 前端工具链
  "node_modules", ".next", ".nuxt", ".turbo", ".parcel-cache",
  "bower_components", ".yarn", ".pnpm-store",
  // Python
  "__pycache__", ".venv", "venv", "env",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox",
  ".eggs", "*.egg-info",
  // Rust / Go / Java / Maven / Gradle
  "target", "vendor", ".gradle", ".idea", ".m2",
  // .NET
  "bin", "obj",
  // 构建 / dist 输出
  "dist", "build", "out", ".output", ".vercel",
  // 缓存和覆盖率
  ".cache", ".tmp", ".temp", "coverage", ".nyc_output",
  "__snapshots__",
]);

/**
 * 隐藏条目（点前缀）在遍历期间被普遍跳过 — * 适用于文件和目录。大多数工具需要这个默认行为。
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== ".";
}

/**
 * 仅目录跳过集合。调用者必须首先检查 `stat.isDirectory()`；
 * `EXCLUDE_DIRS.has(name)` 对常规文件返回 true（例如名为 "build" 的无扩展名脚本）
 * 会将其静默隐藏在搜索之外，这是一个隐患。
 */
export function isExcludedDirName(name: string): boolean {
  return EXCLUDE_DIRS.has(name);
}
