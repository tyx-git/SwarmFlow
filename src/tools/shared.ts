/**
 * Shared utilities for built-in tools.
 *
 * Single source of truth for:
 *  - EXCLUDE_DIRS 鈥?directories that file-system tools skip by default
 *  - truncateMiddle 鈥?symmetrical head+tail truncation for large outputs
 *  - truncateLine    鈥?per-line truncation for grep/read output
 */

// ------------------------------------------------------------------
// Default skip set 鈥?used by glob, grep, list_dir, and file-attach
// ------------------------------------------------------------------

/**
 * Directories that read/search tools skip by default.
 *
 * Roughly mirrors `.gitignore` patterns common across ecosystems
 * (Node, Python, Rust, Go, Java, .NET, frontend toolchains).
 *
 * Tools may still descend into these when the user asks explicitly
 * (e.g. by passing the directory as the `path` argument).
 */
export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  // Version control
  ".git", ".hg", ".svn",
  // Node.js / frontend toolchains
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
  // Build / dist outputs
  "dist", "build", "out", ".output", ".vercel",
  // Caches & coverage
  ".cache", ".tmp", ".temp", "coverage", ".nyc_output",
  "__snapshots__",
]);

/**
 * Hidden entries (dot-prefixed) are skipped universally during walks 鈥? * applies to both files and directories. Most tools want this default.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== ".";
}

/**
 * Directory-only skip set. Callers must check `stat.isDirectory()` first;
 * `EXCLUDE_DIRS.has(name)` returning true for a regular file (e.g. an
 * extensionless script named "build") would silently hide it from search,
 * which is a footgun.
 */
export function isExcludedDirName(name: string): boolean {
  return EXCLUDE_DIRS.has(name);
}

// ------------------------------------------------------------------
// Output truncation
// ------------------------------------------------------------------

/**
 * Truncate text symmetrically: keep the first half and last half of
 * `limit` characters, drop the middle. Returns `text` unchanged if it
 * already fits.
 *
 * Used by bash and web_fetch 鈥?for command/page output, both ends
 * usually carry information (errors at the top, exit summary at the
 * bottom; nav at the top, conclusions at the bottom).
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
 * Truncate a single line at `maxChars`. Used by read_file and grep
 * to keep a runaway minified line from blowing the budget.
 */
export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return (
    line.slice(0, maxChars) +
    ` 鈥?(line truncated at ${maxChars} chars)`
  );
}
