/** 内置工具的资源上限：读取、搜索与 bash 的行数、字符数、字节数和超时。 */

import fs from "node:fs/promises";

import path from "node:path";

import { shell } from "../platform/index.js";

/**
 * grep/glob 单次搜索的墙钟预算。
 * native 与 JS 回退共用同一个值，避免两条路径的超时语义分叉。
 */
export const SEARCH_BUDGET_MS = 15_000;

export const BASH_MAX_TIMEOUT = 600; // 硬上限 10 分钟（秒）

export const BASH_MAX_OUTPUT_CHARS = 200_000; // 每条流约 200 KB 文本上限

export const BASH_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
// 环境变量过滤与 shell 选择都在 src/platform/shell。这份白名单
// 原先定义在这里，名为 BASH_ENV_ALLOWLIST。

// ------------------------------------------------------------------
// 读取限制
// ------------------------------------------------------------------

// 读取、编辑、写入共用的单文件内容上限。
export const FILE_CONTENT_MAX_BYTES = 50 * 1024 * 1024;

// 单次读取熔断行数：普通读取与 tail_lines 共用。超过后截断，
// 并在结果末尾给出继续读取的指引。
export const READ_MAX_LINES = 1000;

export const READ_MAX_CHARS = 80_000;

export const READ_MAX_LINE_CHARS = 5000; // 默认单行上限（挡住压缩文件）；模型可用 max_line_chars 调高

export const READ_LINE_CHARS_FLOOR = 80; // max_line_chars 可接受的最小值

export const READ_LINE_CHARS_CEILING = READ_MAX_CHARS - 1; // 再长的行无论如何都装不进单次调用的字符预算

export const READ_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 图片上限 20 MB

// ------------------------------------------------------------------
// 搜索安全限制
// ------------------------------------------------------------------

export const SEARCH_MAX_DEPTH = 8;

export const SEARCH_MAX_FILES = 5_000;

export const SEARCH_MAX_FILE_SIZE = 1 * 1024 * 1024; // 单文件 1 MB

export const SEARCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 扫描文本合计 16 MB

export const SEARCH_MAX_PATTERN_LENGTH = 300;

export const SEARCH_MAX_PATTERNS = 16; // 多 pattern 合并（OR）的上限

export const SEARCH_DEFAULT_HEAD_LIMIT = 100; // 返回的内容行数 / 文件路径数上限

export const SEARCH_DEFAULT_PER_FILE_LIMIT = 15; // content 模式下每个文件的内容行上限

export const SEARCH_LINE_MAX_CHARS = 2_000; // 单行截断上限

export const SEARCH_OUTPUT_CHAR_CAP = 60_000; // 整体输出上限（头尾保留、中间丢弃）

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

// 宽松的深度护栏——真实项目很少嵌套超过 12 层，
// 但病态的符号链接环可能在文件数护栏触发前就无限递归下去。
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
