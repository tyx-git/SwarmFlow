/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";

import path from "node:path";

import { shell } from "../platform/index.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

/**
 * grep/glob 单次搜索的墙钟预算。
 * native 与 JS 回退共用同一个值，避免两条路径的超时语义分叉。
 */
export const SEARCH_BUDGET_MS = 15_000;

export const BASH_MAX_TIMEOUT = 600; // 10 minutes hard cap (seconds)

export const BASH_MAX_OUTPUT_CHARS = 200_000; // ~200 KB text cap per stream

export const BASH_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
// Env filtering and shell selection live in src/platform/shell. The
// allowlist used to be defined here as BASH_ENV_ALLOWLIST.

// ------------------------------------------------------------------
// 读取限制
// ------------------------------------------------------------------

// 读取、编辑、写入共用的单文件内容上限。
export const FILE_CONTENT_MAX_BYTES = 50 * 1024 * 1024;

// 单次读取熔断行数：普通读取与 tail_lines 共用。超过后截断，
// 并在结果末尾给出继续读取的指引。
export const READ_MAX_LINES = 1000;

export const READ_MAX_CHARS = 80_000;

export const READ_MAX_LINE_CHARS = 5000; // default per-line cap (catches minified files); model can raise via max_line_chars

export const READ_LINE_CHARS_FLOOR = 80; // lowest accepted max_line_chars

export const READ_LINE_CHARS_CEILING = READ_MAX_CHARS - 1; // a longer line could never fit the per-call char budget anyway

export const READ_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB limit for images

// ------------------------------------------------------------------
// 搜索安全限制
// ------------------------------------------------------------------

export const SEARCH_MAX_DEPTH = 8;

export const SEARCH_MAX_FILES = 5_000;

export const SEARCH_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB per file

export const SEARCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB total scanned text

export const SEARCH_MAX_PATTERN_LENGTH = 300;

export const SEARCH_MAX_PATTERNS = 16; // multi-pattern OR cap

export const SEARCH_DEFAULT_HEAD_LIMIT = 100; // max content lines / file paths returned

export const SEARCH_DEFAULT_PER_FILE_LIMIT = 15; // max content lines per file in content mode

export const SEARCH_LINE_MAX_CHARS = 2_000; // per-line truncation cap

export const SEARCH_OUTPUT_CHAR_CAP = 60_000; // overall output cap (head+tail middle-cut)

// content 走 rg --json，JSON 包装比最终文本大；先给事件流更高原始预算，
// 最终仍由 SEARCH_OUTPUT_CHAR_CAP 截断。files/count 继续使用 60k 原始上限。
export const SEARCH_NATIVE_JSON_RAW_CAP = 2_000_000;

// ------------------------------------------------------------------
// 文件写入安全（第 5 阶段）
// ------------------------------------------------------------------

export const LIST_MAX_ENTRIES_DEFAULT = 200;

export const LIST_MAX_ENTRIES_CAP = 2_000;

export const LIST_MAX_DEPTH_DEFAULT = 2;

export const LIST_MAX_DEPTH_CAP = 6;

export const GLOB_DEFAULT_LIMIT = 200;

export const GLOB_MAX_LIMIT = 1_000;

export const GLOB_MAX_FILES_SCANNED = 50_000;

// Generous depth guard —real projects rarely nest >12 deep, but pathological
// symlink loops can recurse forever before the file-count guard fires.
export const GLOB_MAX_DEPTH = 16;

/**
 * 将完整的文本负载溢出到会话范围的临时文件。返回绝对路径。
 * 尽力而为：失败时返回 null（我们不希望溢出失败掩盖原始工具结果）。
 *
 * 在溢出目录中保持 `BASH_SPILL_KEEP_LAST` 个文件的软上限：
 * 写入前，按 mtime 修剪最旧的条目到该数量减 1。
 * 长时间运行的会话可能会累积数十个多 MB 的日志文件。
 */
export const BASH_SPILL_KEEP_LAST = 32;
