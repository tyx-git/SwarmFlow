/**
 * 内置工具的共享实用程序。
 *
 * 单一真实来源：
 *  - EXCLUDE_DIRS — 文件系统工具默认跳过的目录
 *  - truncateMiddle — 大输出的对称头+尾截断
 *  - truncateLine    — grep/read 输出的按行截断
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

// ------------------------------------------------------------------
// 输出截断
// ------------------------------------------------------------------

/**
 * 对称截断文本：保留 `limit` 字符的前半部分和后半部分，
 * 删除中间部分。如果文本已符合限制则返回不变。
 *
 * 由 bash 和 web_fetch 使用 —— 对于命令/页面输出，两端
 * 通常都携带信息（顶部的错误，底部的退出摘要；
 * 顶部的导航，底部的结论）。
 */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return (
    text.slice(0, half) +
    `\n\n... [truncated ${omitted.toLocaleString()} chars] ...\n\n` +
    text.slice(-half)
  );
}

/**
 * 在 `maxChars` 处截断单行。由 read_file 和 grep 使用，
 * 以防止失控的压缩行超出预算。
 */
export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return (
    line.slice(0, maxChars) +
    ` —(line truncated at ${maxChars} chars)`
  );
}
