/** 内置工具的 ToolDef 定义：读取、编辑、shell、时间、搜索与网络工具；执行器分派见 dispatch.ts。 */

import fs from "node:fs/promises";

import path from "node:path";

import { shell } from "../platform/index.js";

import type { ToolDef } from "../providers/types.js";

import { WEB_SEARCH } from "./web-search/tool.js";
import { WEB_FETCH } from "./web-fetch.js";

import { FIND_SYMBOL } from "./symbol-search.js";
import { JQ } from "./json-query.js";

export const READ: ToolDef = {
  name: "read_file",
  description:
    "Read the contents of a text file (max 50 MB). " +
    "Returns up to 1000 lines / 80,000 characters per call; " +
    "individual lines longer than 5000 chars are truncated by default (raise max_line_chars when you need a long line in full). " +
    "PDF, DOCX, XLSX, and similar formats are returned as auto-extracted Markdown. " +
    "Image files are returned as visual content blocks when the model supports multimodal input. " +
    "Returns file metadata (including mtime_ms) for optional optimistic concurrency checks. " +
    "Use start_line+end_line (inclusive range) or offset+limit (offset = first line, limit = number of lines) to navigate large files across multiple calls. " +
    "Each call returns at most 1000 lines; when the file is longer, the result ends with the start_line to use next. " +
    "Use tail_lines to read the end of a file when you do not know how many lines it has — logs especially. " +
    "tail_lines is also capped at the latest 1000 lines. " +
    "If you know there are several files to read, prefer issuing multiple read_file calls in parallel.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path",
      },
      start_line: {
        type: "integer",
        description: "First line to read (1-indexed, inclusive). Defaults to 1. Alias: offset.",
      },
      end_line: {
        type: "integer",
        description:
          "Last line to read (1-indexed, inclusive). Use -1 to read to the end of the file.",
      },
      offset: {
        type: "integer",
        description: "Alias for start_line (1-indexed first line). Must be >= 1.",
      },
      limit: {
        type: "integer",
        description:
          "Number of lines to read starting at start_line/offset (NOT an alias for end_line). " +
          "For example, offset=50, limit=100 reads lines 50-149. Must be >= 1.",
      },
      max_line_chars: {
        type: "integer",
        description:
          "Per-line character cap (default 5000). When output marks a line as truncated, " +
          "re-read with a larger value to see it in full. The 80,000-character per-call budget still applies.",
      },
      tail_lines: {
        type: "integer",
        description:
          "Read only the last N lines (max 1000). For logs and other files whose length you do not know. " +
          "Overrides start_line/end_line/offset/limit.",
      },
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is reading {path}",
  tuiPolicy: { partialReveal: { completeArgs: ["path"] } },
};

export const LIST: ToolDef = {
  name: "list_dir",
  description:
    "List a directory tree, indented, with files showing their size in bytes. Directories come before files " +
    "and entries are sorted alphabetically at each level. Depth and entry count are capped by max_depth and " +
    "max_entries; hitting the cap appends a \"(truncated)\" notice rather than stopping silently. " +
    "Common build / cache directories (node_modules, .git, dist, target, .venv, etc.) are skipped by default; " +
    "to inspect one, pass it as the `path` argument explicitly. " +
    "If you are searching for a specific filename, prefer `glob`; for content matches, prefer `grep`.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (default: current directory)",
        default: ".",
      },
      max_depth: {
        type: "integer",
        description: `Maximum recursion depth (1-${LIST_MAX_DEPTH_CAP}, default ${LIST_MAX_DEPTH_DEFAULT}).`,
      },
      max_entries: {
        type: "integer",
        description:
          `Maximum entries to return (default ${LIST_MAX_ENTRIES_DEFAULT}, cap ${LIST_MAX_ENTRIES_CAP}). ` +
          `When the cap is hit the output ends with a "(truncated)" notice.`,
      },
      include_hidden: {
        type: "boolean",
        description: "Include hidden (dot-prefixed) entries. Default false.",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is listing {path}",
  tuiPolicy: { partialReveal: { completeArgs: ["path"] } },
};

export const EDIT: ToolDef = {
  name: "edit_file",
  description:
    "Apply a patch to an existing file. Each edit replaces an `old_str` with a `new_str`; " +
    "by default `old_str` must appear exactly once in the file (or the call fails with the line numbers of all matches so you can disambiguate). " +
    "Set `replace_all: true` on an edit to replace every occurrence —useful for renames. " +
    "Multiple edits in one call are applied atomically and must not overlap. " +
    "Use `append_str` to add content at the end of the file (can be combined with edits —appends run last). " +
    "Refuses no-op edits where `old_str === new_str`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      edits: {
        type: "array",
        description: "One or more replacements applied in a single atomic write.",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact string to find (must be unique unless replace_all=true)." },
            new_str: { type: "string", description: "Replacement string. Must differ from old_str." },
            replace_all: {
              type: "boolean",
              description: "Replace every occurrence instead of requiring uniqueness. Default false.",
            },
          },
          required: ["old_str", "new_str"],
        },
      },
      append_str: {
        type: "string",
        description:
          "Content to append to the end of the file. " +
          "Can be used alone or combined with edits (append always executes last).",
      },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard. " +
          "If provided, edit is rejected when the file mtime differs (milliseconds since epoch).",
      },
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is editing {path}",
  tuiPolicy: { partialReveal: { completeArgs: ["path"] } },
};

export const WRITE: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically. " +
    "Prefer write_file over edit_file when you intend to replace the entire file —it is fewer tokens " +
    "than echoing the full existing content into edit_file. Use edit_file for targeted modifications.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full file content" },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard for overwrites. " +
          "If provided, write is rejected when the existing file mtime differs (milliseconds since epoch).",
      },
    },
    required: ["path", "content"],
  },
  summaryTemplate: "{agent} is writing to {path}",
  tuiPolicy: { partialReveal: { completeArgs: ["path"] } },
};

// ------------------------------------------------------------------
// Shell 感知的 bash 工具描述
// ------------------------------------------------------------------

import type { ShellKind } from "../platform/index.js";
import {
  LIST_MAX_DEPTH_CAP,
  LIST_MAX_DEPTH_DEFAULT,
  LIST_MAX_ENTRIES_DEFAULT,
  LIST_MAX_ENTRIES_CAP,
  BASH_MAX_TIMEOUT,
  GLOB_DEFAULT_LIMIT,
  GLOB_MAX_LIMIT,
  SEARCH_DEFAULT_HEAD_LIMIT,
  SEARCH_DEFAULT_PER_FILE_LIMIT,
} from "./limits.js";

export const BASH_DESCRIPTION_BASE =
  "Execute a synchronous shell command and return stdout, stderr, and exit code.\n\n" +
  "TIMEOUT is REQUIRED —it is the synchronous wait budget, not a kill switch. If the " +
  "command finishes in time you get its full output as usual. If the timeout elapses, " +
  "the command is NOT killed: it keeps running and is moved to a tracked background " +
  "shell. The tool returns the output captured so far, the shell id, and the absolute " +
  "log path inside the project's `.swarmflow` session directory (`<session-id>/shells`; " +
  "child agents use `<root-session-id>/agents/<child-id>/shells`). Read that path with " +
  "`read_file` (`tail_lines=200` shows the latest output), wait for it with `await_event`, " +
  "or stop it with `kill_shell` as available. " +
  "Never re-run a command just because it timed out: its side effects are still in " +
  "progress —inspect the shell instead. When stdout/stderr is truncated, the full text " +
  "is saved under the session artifacts directory and the result includes its absolute path.\n\n" +
  "Choose the timeout to match how long you are willing to block on the result. " +
  "Known long-running jobs are better started with your dedicated background-shell " +
  "tool when the session provides one (clearer intent, cleaner logs). Persistent " +
  "processes that never exit on their own —dev servers, file watchers, daemons, " +
  "`npm run dev`, `vite`, `next dev`, `cargo watch`, `tail -f` —should ALWAYS use " +
  "that tool when available.\n\n" +
  "After a timeout hand-off, look at the partial output: if the command appears stuck " +
  "or was waiting for interactive input, stop it with `kill_shell` when available " +
  "rather than leaving a zombie shell behind.";

export function shellLabel(kind: ShellKind): string {
  switch (kind) {
    case "pwsh": return "PowerShell 7+";
    case "powershell": return "Windows PowerShell 5.1";
    default: return "bash";
  }
}

export function shellAwareDescription(kind: ShellKind): string {
  const label = shellLabel(kind);
  const prefix = `Shell: ${label}. `;
  if (kind === "pwsh" || kind === "powershell") {
    return prefix +
      "All commands run through PowerShell —write PowerShell syntax, not bash. " +
      "See the system prompt for full PowerShell syntax guidance.\n\n" +
      BASH_DESCRIPTION_BASE;
  }
  return prefix + BASH_DESCRIPTION_BASE;
}

export function buildBashToolDef(kind: ShellKind): ToolDef {
  return {
    name: "bash",
    description: shellAwareDescription(kind),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: {
          type: "integer",
          description:
            `Required. Synchronous wait budget in seconds (1-${BASH_MAX_TIMEOUT}). If the command ` +
            "is still running when it elapses, the command is moved to a tracked background " +
            "shell and keeps running (it is not killed).",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command (default: current directory)",
        },
      },
      required: ["command", "timeout"],
    },
    summaryTemplate: "{agent} is running: {command}",
    tuiPolicy: { partialReveal: { completeArgs: ["command"] } },
  };
}

export const BASH: ToolDef = buildBashToolDef(shell.kind);

export const TIME: ToolDef = {
  name: "time",
  description:
    "Return the current local time of the runtime environment, including timezone and UTC offset.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summaryTemplate: "{agent} is checking current time",
  tuiPolicy: { partialReveal: "immediate" },
};

// ------------------------------------------------------------------
// Glob 工具
// ------------------------------------------------------------------

export const GLOB: ToolDef = {
  name: "glob",
  description:
    "Find files by name/path pattern. Returns matching absolute paths sorted by modification time " +
    "(most recently modified first). Patterns without `/` are auto-prefixed with `**/` so " +
    "`*.ts` matches every `.ts` file in the tree. " +
    "Respects .gitignore/.ignore rules (including the global gitignore) and skips common build / cache directories (node_modules, .git, dist, target, .venv, etc.) " +
    "unless `no_ignore` is true. Supports `**`, `*`, `?`, `[abc]`, and `{a,b}` brace expansion.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern (e.g. \"*.ts\", \"**/*.test.tsx\", \"src/**/*.{ts,tsx}\"). " +
          "Patterns without a slash are matched anywhere in the tree.",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory).",
        default: ".",
      },
      limit: {
        type: "integer",
        description: `Maximum results to return (default ${GLOB_DEFAULT_LIMIT}, cap ${GLOB_MAX_LIMIT}).`,
      },
      max_results: {
        type: "integer",
        description: "Alias for limit.",
      },
      type: {
        description: "Entry type: file (default), directory, symlink, executable, or empty. May be an array.",
        oneOf: [
          { type: "string", enum: ["file", "directory", "dir", "symlink", "executable", "empty"] },
          { type: "array", items: { type: "string" } },
        ],
      },
      extension: {
        description: "Filter by one or more file extensions, with or without the leading dot.",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      and: {
        type: "array",
        items: { type: "string" },
        description: "Additional glob patterns that must also match the same entry.",
      },
      exclude: {
        description: "Entry glob(s) to exclude, such as node_modules or *.map.",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      regex: {
        type: "boolean",
        description: "Treat pattern as a regular expression instead of a glob pattern.",
      },
      fixed_strings: {
        type: "boolean",
        description: "Treat pattern as a literal substring.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Force case-insensitive matching; default is smart case.",
      },
      full_path: {
        type: "boolean",
        description: "Match the pattern against the full relative path instead of only the entry name.",
      },
      absolute_path: {
        type: "boolean",
        description: "Return absolute paths (the default for compatibility).",
      },
      include_hidden: {
        type: "boolean",
        description: "Include hidden entries. Default false.",
      },
      no_ignore: {
        type: "boolean",
        description: "Do not skip .gitignore/.ignore rules or standard build/cache directories. Default false.",
      },
      follow: {
        type: "boolean",
        description: "Traverse symbolic-link directories. Default false.",
      },
      max_depth: {
        type: "integer",
        description: "Maximum traversal depth, relative to path.",
      },
      min_depth: {
        type: "integer",
        description: "Only return entries at or below this depth.",
      },
      exact_depth: {
        type: "integer",
        description: "Only return entries at this depth.",
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is finding files matching '{pattern}'",
  tuiPolicy: { partialReveal: { completeArgs: ["pattern"] } },
};

// ------------------------------------------------------------------
// Grep 工具（增强搜索）
// ------------------------------------------------------------------

export const GREP: ToolDef = {
  name: "grep",
  description:
    "Search file contents by regex. Pattern can be a single string OR an array of strings " +
    "(matches lines that contain ANY of the patterns —useful for snake_case/camelCase/PascalCase variants in one call). " +
    "Smart case: an all-lowercase pattern is matched case-insensitively; set `-i` explicitly to force " +
    "case-insensitive matching for mixed-case patterns. " +
    "Defaults: returns up to 100 results overall and 15 matching lines per file in content mode; " +
    "individual lines longer than 2000 chars are truncated. " +
    "Respects .gitignore rules (including the global gitignore) and skips common build/cache directories unless `no_ignore` is true.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        description:
          "Regex pattern, or an array of regex patterns combined with OR logic. " +
          "Plain identifiers are best —keep regex simple to avoid 0 matches.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: current directory).",
        default: ".",
      },
      glob: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Filename glob filter(s), including rg negated globs such as !vendor/**.",
      },
      type: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "File type filter by extension (e.g. \"js\", \"py\", \"ts\").",
      },
      fixed_strings: {
        type: "boolean",
        description: "Treat patterns as literal strings rather than regular expressions (-F).",
      },
      word_regexp: {
        type: "boolean",
        description: "Only match whole words (-w).",
      },
      line_regexp: {
        type: "boolean",
        description: "Only match complete lines (-x).",
      },
      multiline: {
        type: "boolean",
        description: "Allow matches to span lines (-U).",
      },
      hidden: {
        type: "boolean",
        description: "Search hidden files and directories. Default false.",
      },
      no_ignore: {
        type: "boolean",
        description: "Search files ignored by .gitignore and standard build/cache directories.",
      },
      follow: {
        type: "boolean",
        description: "Follow symbolic links during directory traversal.",
      },
      max_depth: {
        type: "integer",
        description: "Maximum directory traversal depth.",
      },
      max_count: {
        type: "integer",
        description: "Maximum matching lines per file (-m).",
      },
      invert_match: {
        type: "boolean",
        description: "Return non-matching lines (-v).",
      },
      only_matching: {
        type: "boolean",
        description: "Return only the matching text (-o; content mode).",
      },
      count_matches: {
        type: "boolean",
        description: "Count individual matches instead of matching lines (--count-matches).",
      },
      include_zero: {
        type: "boolean",
        description: "Include files with zero matches in count mode.",
      },
      text: {
        type: "boolean",
        description: "Search binary files as text (-a).",
      },
      sort: {
        type: "string",
        enum: ["path", "modified", "none"],
        description: "Sort matched file paths; default traversal order.",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "Output mode. \"files_with_matches\" (default) returns paths only. " +
          "\"content\" returns matching lines (optionally with context). " +
          "\"count\" returns N matches per file.",
      },
      "-A": {
        type: "integer",
        description: "Context lines AFTER each match (content mode only). Alias: after_lines.",
      },
      "-B": {
        type: "integer",
        description: "Context lines BEFORE each match (content mode only). Alias: before_lines.",
      },
      "-C": {
        type: "integer",
        description: "Context lines BOTH before and after each match. Alias: context_lines.",
      },
      "-i": {
        type: "boolean",
        description: "Force case-insensitive search (overrides smart case). Alias: case_insensitive.",
      },
      "-n": {
        type: "boolean",
        description: "Show line numbers (default true for content mode). Alias: line_numbers.",
      },
      head_limit: {
        type: "integer",
        description: `Cap overall results to N entries (default ${SEARCH_DEFAULT_HEAD_LIMIT}).`,
      },
      limit_per_file: {
        type: "integer",
        description: `Cap matches per file in content mode (default ${SEARCH_DEFAULT_PER_FILE_LIMIT}).`,
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is searching for '{pattern}'",
  tuiPolicy: { partialReveal: { completeArgs: ["pattern"] } },
};

// ------------------------------------------------------------------
// 后台 shell 工具（由 Session 追踪）
// ------------------------------------------------------------------

export const BASH_BACKGROUND_TOOL: ToolDef = {
  name: "bash_background",
  description:
    "Start a background shell command tracked by the Session. " +
    "Use for dev servers, watchers, and long-running commands whose output you want to inspect later. " +
    "Logs are saved inside the project `.swarmflow` session directory: " +
    "`.swarmflow/<session-id>/shells/<shell-id>.log` for a root session, or " +
    "`.swarmflow/<root-session-id>/agents/<child-id>/shells/<shell-id>.log` for a child agent. " +
    "The result includes the exact absolute `log:` path; read that path with `read_file`.\n\n" +
    "Don't leave zombie shells behind: when a background shell is no longer needed for your work " +
    "AND has no value to the user, remember to kill_shell it. The exception is processes the user " +
    "benefits from directly —a dev server they are clicking around in (`npm run dev`, `vite`) " +
    "should keep running unless they say otherwise.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute in the background." },
      cwd: { type: "string", description: "Optional working directory for the command." },
      id: {
        type: "string",
        description: "Optional stable shell ID. If omitted, the Session generates one.",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is starting a background shell",
  tuiPolicy: { partialReveal: { completeArgs: ["command"] } },
};

export const KILL_SHELL_TOOL: ToolDef = {
  name: "kill_shell",
  description:
    "Terminate one or more tracked background shells. " +
    "The signal is sent to the entire process group so children (npm →vite, etc.) are killed in full. " +
    "After kill the shell entry stays so you can read its final log at the same absolute `log:` path " +
    "returned when the shell started or in status output, but the process is gone —" +
    "killed shells do not auto-restart, and HMR / file-watching stops. " +
    "The same id can be reused once the prior shell has stopped.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Tracked shell IDs to terminate.",
      },
      signal: {
        type: "string",
        description: "Optional signal name (default TERM).",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is terminating background shells",
  tuiPolicy: { partialReveal: "closed" },
};

// ------------------------------------------------------------------
// 导出：工具列表
// ------------------------------------------------------------------

export const BASIC_TOOLS: ToolDef[] = [
  READ,
  LIST,
  GLOB,
  GREP,
  FIND_SYMBOL,
  JQ,
  EDIT,
  WRITE,
  BASH,
  BASH_BACKGROUND_TOOL,
  KILL_SHELL_TOOL,
  TIME,
  WEB_SEARCH,
  WEB_FETCH,
];

export const BASIC_TOOLS_MAP: Record<string, ToolDef> = Object.fromEntries(
  BASIC_TOOLS.map((t) => [t.name, t]),
);

// ======================================================================
// 工具执行器
// ======================================================================

// ------------------------------------------------------------------
// read_file
// ------------------------------------------------------------------
