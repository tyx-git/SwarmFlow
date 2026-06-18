/**
 * Built-in tool definitions and executors.
 *
 * 13 tools: read_file, list_dir, glob, grep, edit_file, write_file,
 * bash, bash_background, bash_output, kill_shell,
 * time, web_search, web_fetch.
 */

import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync, readdirSync, realpathSync, writeFileSync as fsWriteFileSync, unlinkSync, mkdirSync, copyFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { osCapabilities, shell } from "../platform/index.js";

import type { ToolDef } from "../providers/base.js";
import { ToolResult } from "../providers/base.js";
import type { ToolExecutor, ToolExecutorContext } from "./executor-types.js";
import {
  safePath,
  SafePathError,
  type PathAccessKind,
} from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import {
  WEB_SEARCH,
  toolBuiltinWebSearchPassthrough,
  toolWebSearch,
} from "./web-search.js";
import { WEB_FETCH, toolWebFetch } from "./web-fetch.js";
import {
  isProjectedDocumentPath,
  loadProjectedDocumentView,
  projectedDocumentLabel,
} from "../context/document-projection.js";
import { classifyFile, IMAGE_MEDIA_TYPES } from "../lib/file-attach.js";
import { createPatch } from "diff";
import {
  isExcludedDirName,
  isHiddenName,
  truncateMiddle,
  truncateLine,
} from "./shared.js";
import { coercePathString } from "./arg-repair.js";
import {
  type FileModifyDisplayData,
  type MatchInfo,
  inferLanguageByExt,
  countFileLines,
  buildHunkFromMatch,
  buildMultiEditHunks,
  buildAppendDisplayData,
  buildWriteDisplayData,
} from "../lib/diff-hunk.js";

// ------------------------------------------------------------------
// File mutation tracking (for rewind file revert)
// ------------------------------------------------------------------

export interface FileMutation {
  path: string;
  kind: "created" | "modified";
  reversePatch: string | null;
  postImageSha: string;
  additions: number;
  deletions: number;
  untracked?: true;
}

// ------------------------------------------------------------------
// Bash mutation tracking (mkdir/cp/mv)
// ------------------------------------------------------------------

export interface BashMutationEntry {
  kind: "mkdir" | "cp" | "mv";
  /** mkdir: directories created (in creation order, revert removes deepest first). */
  createdDirs?: string[];
  /** cp/mv: source path. */
  source?: string;
  /** cp/mv: target path. */
  target?: string;
  /** Whether the target file existed before the operation. */
  targetExisted?: boolean;
  /** Path to backup of overwritten file (in session artifacts). */
  backupPath?: string;
  /** cp -r: recursive copy created a new directory tree. */
  recursive?: boolean;
  /** SHA256 of the target file after execution (for conflict detection). */
  postImageSha?: string;
}

export interface BashMutation {
  command: string;
  entries: BashMutationEntry[];
}

// ------------------------------------------------------------------
// Bash mutation tracking: pre-exec snapshot 鈫?execute 鈫?post-exec record
// ------------------------------------------------------------------

interface BashPreExecState {
  kind: "mkdir" | "cp" | "mv";
  args: string[];
  /** mkdir -p: which path segments already existed before execution. */
  existingAncestors?: string[];
  /** cp/mv: resolved target path. */
  targetPath?: string;
  /** cp/mv: whether target existed before. */
  targetExisted?: boolean;
  /** cp/mv: backup file path (if target was an existing file). */
  backupPath?: string;
  /** cp -r flag. */
  recursive?: boolean;
  /** cp/mv: source path. */
  sourcePath?: string;
}

const TRACKED_BASH_COMMANDS = new Set(["mkdir", "cp", "mv"]);

export interface TrackableBashParsed {
  cmd: "mkdir" | "cp" | "mv";
  flags: string[];
  args: string[];
}

/**
 * Parse a bash segment into a trackable mutation command.
 * Returns null for unsupported syntax (multi-source, -t flag, complex quoting, etc.).
 * Classifier and tracker both call this to enforce the contract:
 * if this returns null, the command cannot be accurately tracked for rewind.
 */
export function parseTrackableBashMutation(segment: string): TrackableBashParsed | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  // Quote-aware tokenization
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "\\" && !inSingle && i + 1 < trimmed.length) { current += trimmed[i + 1]; i++; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  // Unclosed quotes 鈫?can't parse reliably
  if (inSingle || inDouble) return null;

  if (tokens.length < 2) return null;
  const cmd = (tokens[0]!.split("/").pop() ?? tokens[0]!) as string;
  if (!TRACKED_BASH_COMMANDS.has(cmd)) return null;

  const flags: string[] = [];
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) flags.push(t);
    else args.push(t);
  }

  // Reject unsupported cp/mv syntax
  if (cmd === "cp" || cmd === "mv") {
    // -t / --target-directory not supported (including grouped flags like -rt)
    if (flags.some(f => f.startsWith("--target-directory") || (!f.startsWith("--") && f.includes("t")))) return null;
    // --parents not supported
    if (flags.some(f => f === "--parents")) return null;
    // Need exactly 2 positional args (single source + single target)
    if (args.length !== 2) return null;
  }

  return { cmd: cmd as "mkdir" | "cp" | "mv", flags, args };
}

/**
 * Check if a bash segment is a trackable mutation that can be accurately
 * recorded for rewind. Used by the permission classifier to enforce the
 * contract: if not trackable, the command must not be classified as write_reversible.
 */
export function isTrackableBashMutation(segment: string): boolean {
  return parseTrackableBashMutation(segment) !== null;
}

function prepareBashPreExec(
  segment: string,
  backupsDir: string,
  cwd: string,
): BashPreExecState | null {
  const parsed = parseTrackableBashMutation(segment);
  if (!parsed) return null;

  const resolve = (p: string) => path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);

  if (parsed.cmd === "mkdir") {
    const hasDashP = parsed.flags.some(f => f === "-p" || (f.startsWith("-") && f.includes("p") && !f.startsWith("--")));
    const dirs = parsed.args.map(resolve);
    if (hasDashP && dirs.length > 0) {
      const existingAncestors: string[] = [];
      for (const dir of dirs) {
        let current = dir;
        while (current !== path.dirname(current)) {
          if (existsSync(current)) {
            existingAncestors.push(current);
            break;
          }
          current = path.dirname(current);
        }
      }
      return { kind: "mkdir", args: dirs, existingAncestors };
    }
    return { kind: "mkdir", args: dirs };
  }

  if (parsed.cmd === "cp" || parsed.cmd === "mv") {
    // parseTrackableBashMutation already enforces args.length === 2
    const sourcePath = resolve(parsed.args[0]!);
    let targetPath = resolve(parsed.args[1]!);
    const recursive = parsed.flags.some(f => f === "-r" || f === "-R" || f === "--recursive" ||
      (f.startsWith("-") && !f.startsWith("--") && f.includes("r")));

    // When target is an existing directory, shell writes to dir/basename(source)
    if (existsSync(targetPath)) {
      try {
        if (statSync(targetPath).isDirectory()) {
          targetPath = path.join(targetPath, path.basename(sourcePath));
        }
      } catch { /* ignore stat errors */ }
    }

    let targetExisted = false;
    let backupPath: string | undefined;

    if (existsSync(targetPath)) {
      try {
        if (statSync(targetPath).isFile()) {
          targetExisted = true;
          mkdirSync(backupsDir, { recursive: true });
          backupPath = path.join(backupsDir, randomUUID());
          copyFileSync(targetPath, backupPath);
        }
      } catch { /* ignore */ }
    }

    return {
      kind: parsed.cmd as "cp" | "mv",
      args: [sourcePath, targetPath],
      targetPath,
      targetExisted,
      backupPath,
      recursive,
      sourcePath,
    };
  }

  return null;
}

function recordBashPostExec(
  preExec: BashPreExecState,
): BashMutationEntry | null {
  if (preExec.kind === "mkdir") {
    const createdDirs: string[] = [];
    for (const dir of preExec.args) {
      if (!existsSync(dir)) continue;
      if (preExec.existingAncestors) {
        // mkdir -p: walk from target up, collect all dirs that are new
        let current = dir;
        const newDirs: string[] = [];
        while (current !== path.dirname(current)) {
          if (preExec.existingAncestors.includes(current)) break;
          if (existsSync(current)) newDirs.push(current);
          current = path.dirname(current);
        }
        createdDirs.push(...newDirs.reverse());
      } else {
        if (existsSync(dir)) createdDirs.push(dir);
      }
    }
    if (createdDirs.length === 0) return null;
    return { kind: "mkdir", createdDirs };
  }

  if (preExec.kind === "cp" || preExec.kind === "mv") {
    if (!preExec.targetPath) return null;
    if (!existsSync(preExec.targetPath)) return null;

    let postImageSha: string | undefined;
    try {
      const st = statSync(preExec.targetPath);
      if (st.isFile()) {
        postImageSha = createHash("sha256").update(readFileSync(preExec.targetPath)).digest("hex");
      }
    } catch { /* ignore */ }

    return {
      kind: preExec.kind,
      source: preExec.sourcePath,
      target: preExec.targetPath,
      targetExisted: preExec.targetExisted,
      backupPath: preExec.backupPath,
      recursive: preExec.recursive || undefined,
      postImageSha,
    };
  }

  return null;
}

function splitCompoundBash(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (ch === "\\" && !inSingle && i + 1 < command.length) { current += ch + command[i + 1]; i++; continue; }
    if (!inSingle && !inDouble) {
      if (ch === "&" && command[i + 1] === "&") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === "|" && command[i + 1] === "|") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === ";") { if (current.trim()) segments.push(current.trim()); current = ""; continue; }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Extract cd target from a bash segment (for mutation tracking).
 * Inline version 鈥?avoids importing cd-context.ts to prevent circular deps.
 */
function extractCdTargetForBash(segment: string): string | null {
  const trimmed = segment.trim().replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const parts = trimmed.split(/\s+/);
  if (parts[0] !== "cd") return null;
  if (parts.length === 1) return homedir();
  const target = parts[1]!;
  if (target === "-" || (target.startsWith("$") && target !== "$HOME") || target.includes("`") || target.includes("$(")) return null;
  if (target === "$HOME" || target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));
  return target;
}

function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function countDiffLines(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  if (before === "") return { additions: afterLines.length, deletions: 0 };
  if (after === "") return { additions: 0, deletions: beforeLines.length };
  let additions = 0;
  let deletions = 0;
  const beforeSet = new Map<string, number>();
  for (const line of beforeLines) {
    beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  }
  for (const line of afterLines) {
    const count = beforeSet.get(line) ?? 0;
    if (count > 0) {
      beforeSet.set(line, count - 1);
    } else {
      additions++;
    }
  }
  for (const count of beforeSet.values()) {
    deletions += count;
  }
  return { additions, deletions };
}

function buildFileMutation(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  fileExistedBefore: boolean,
): FileMutation {
  const postImageSha = computeSha256(afterContent);
  const reversePatch = createPatch(filePath, afterContent, beforeContent);
  const { additions, deletions } = countDiffLines(beforeContent, afterContent);
  return {
    path: filePath,
    kind: fileExistedBefore ? "modified" : "created",
    reversePatch,
    postImageSha,
    additions,
    deletions,
  };
}

// ------------------------------------------------------------------
// Bash safety limits
// ------------------------------------------------------------------

const BASH_MAX_TIMEOUT = 600; // 10 minutes hard cap (seconds)
const BASH_MAX_OUTPUT_CHARS = 200_000; // ~200 KB text cap per stream
const BASH_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
// Env filtering and shell selection live in src/platform/shell. The
// allowlist used to be defined here as BASH_ENV_ALLOWLIST.

// ------------------------------------------------------------------
// Read limits
// ------------------------------------------------------------------

const READ_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 80_000;
const READ_MAX_LINE_CHARS = 5000; // default per-line cap (catches minified files); model can raise via max_line_chars
const READ_LINE_CHARS_FLOOR = 80; // lowest accepted max_line_chars
const READ_LINE_CHARS_CEILING = READ_MAX_CHARS - 1; // a longer line could never fit the per-call char budget anyway
const READ_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB limit for images

// ------------------------------------------------------------------
// Search safety limits
// ------------------------------------------------------------------

const SEARCH_MAX_DEPTH = 8;
const SEARCH_MAX_FILES = 5_000;
const SEARCH_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB per file
const SEARCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB total scanned text
const SEARCH_MAX_PATTERN_LENGTH = 300;
const SEARCH_MAX_PATTERNS = 16; // multi-pattern OR cap
const SEARCH_MAX_DURATION_MS = 4_000;
const SEARCH_DEFAULT_HEAD_LIMIT = 100; // max content lines / file paths returned
const SEARCH_DEFAULT_PER_FILE_LIMIT = 15; // max content lines per file in content mode
const SEARCH_LINE_MAX_CHARS = 2_000; // per-line truncation cap
const SEARCH_OUTPUT_CHAR_CAP = 60_000; // overall output cap (head+tail middle-cut)

// ------------------------------------------------------------------
// File write safety (Phase 5)
// ------------------------------------------------------------------

const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();

// ======================================================================
// Tool definitions (provider-agnostic JSON Schema)
// ======================================================================

const READ: ToolDef = {
  name: "read_file",
  description:
    "Read the contents of a text file (max 50 MB). " +
    "Returns up to 2000 lines / 80,000 characters per call; " +
    "individual lines longer than 5000 chars are truncated by default (raise max_line_chars when you need a long line in full). " +
    "PDF, DOCX, XLSX, and similar formats are returned as auto-extracted Markdown. " +
    "Image files are returned as visual content blocks when the model supports multimodal input. " +
    "Returns file metadata (including mtime_ms) for optional optimistic concurrency checks. " +
    "Use start_line+end_line (inclusive range) or offset+limit (offset = first line, limit = number of lines) to navigate large files across multiple calls. " +
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
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is reading {path}",
  tuiPolicy: { partialReveal: { completeArgs: ["path"] } },
};

const LIST_MAX_ENTRIES_DEFAULT = 200;
const LIST_MAX_ENTRIES_CAP = 2_000;
const LIST_MAX_DEPTH_DEFAULT = 2;
const LIST_MAX_DEPTH_CAP = 6;

const LIST: ToolDef = {
  name: "list_dir",
  description:
    "List files and directories as a tree. Returns names with file sizes for files. " +
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


const EDIT: ToolDef = {
  name: "edit_file",
  description:
    "Apply a patch to an existing file. Each edit replaces an `old_str` with a `new_str`; " +
    "by default `old_str` must appear exactly once in the file (or the call fails with the line numbers of all matches so you can disambiguate). " +
    "Set `replace_all: true` on an edit to replace every occurrence 鈥?useful for renames. " +
    "Multiple edits in one call are applied atomically and must not overlap. " +
    "Use `append_str` to add content at the end of the file (can be combined with edits 鈥?appends run last). " +
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

const WRITE: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically. " +
    "Prefer write_file over edit_file when you intend to replace the entire file 鈥?it is fewer tokens " +
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
// Shell-aware bash tool description
// ------------------------------------------------------------------

import type { ShellKind } from "../platform/index.js";

const BASH_DESCRIPTION_BASE =
  "Execute a synchronous shell command and return stdout, stderr, and exit code.\n\n" +
  "TIMEOUT is REQUIRED 鈥?it is the synchronous wait budget, not a kill switch. If the " +
  "command finishes in time you get its full output as usual. If the timeout elapses, " +
  "the command is NOT killed: it keeps running and is moved to a tracked background " +
  "shell. The tool returns the output captured so far plus the shell id 鈥?poll it with " +
  "`bash_output`, wait with `await_event`, or stop it with `kill_shell`. Never re-run a " +
  "command just because it timed out: its side effects are still in progress 鈥?poll the " +
  "shell instead.\n\n" +
  "Choose the timeout to match how long you are willing to block on the result. " +
  "Known long-running jobs are better started with bash_background directly (clearer " +
  "intent, cleaner logs). Persistent processes that never exit on their own 鈥?dev " +
  "servers, file watchers, daemons, `npm run dev`, `vite`, `next dev`, `cargo watch`, " +
  "`tail -f` 鈥?should ALWAYS use bash_background.\n\n" +
  "After a timeout hand-off, look at the partial output: if the command appears stuck " +
  "or was waiting for interactive input, remember to kill_shell it rather than leaving " +
  "a zombie shell behind.";

function shellLabel(kind: ShellKind): string {
  switch (kind) {
    case "pwsh": return "PowerShell 7+";
    case "powershell": return "Windows PowerShell 5.1";
    default: return "bash";
  }
}

function shellAwareDescription(kind: ShellKind): string {
  const label = shellLabel(kind);
  const prefix = `Shell: ${label}. `;
  if (kind === "pwsh" || kind === "powershell") {
    return prefix +
      "All commands run through PowerShell 鈥?write PowerShell syntax, not bash. " +
      "See the system prompt for full PowerShell syntax guidance.\n\n" +
      BASH_DESCRIPTION_BASE;
  }
  return prefix + BASH_DESCRIPTION_BASE;
}

function buildBashToolDef(kind: ShellKind): ToolDef {
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

const BASH: ToolDef = buildBashToolDef(shell.kind);

const TIME: ToolDef = {
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
// Glob tool
// ------------------------------------------------------------------

const GLOB_DEFAULT_LIMIT = 200;
const GLOB_MAX_LIMIT = 1_000;
const GLOB_MAX_FILES_SCANNED = 50_000;
// Generous depth guard 鈥?real projects rarely nest >12 deep, but pathological
// symlink loops can recurse forever before the file-count guard fires.
const GLOB_MAX_DEPTH = 16;

const GLOB: ToolDef = {
  name: "glob",
  description:
    "Find files by name/path pattern. Returns matching absolute paths sorted by modification time " +
    "(most recently modified first). Patterns without `/` are auto-prefixed with `**/` so " +
    "`*.ts` matches every `.ts` file in the tree. " +
    "Common build / cache directories (node_modules, .git, dist, target, .venv, etc.) are skipped. " +
    "Supports `**`, `*`, `?`, `[abc]`, and `{a,b}` brace expansion.",
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
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is finding files matching '{pattern}'",
  tuiPolicy: { partialReveal: { completeArgs: ["pattern"] } },
};

// ------------------------------------------------------------------
// Grep tool (enhanced search)
// ------------------------------------------------------------------

const GREP: ToolDef = {
  name: "grep",
  description:
    "Search file contents by regex. Pattern can be a single string OR an array of strings " +
    "(matches lines that contain ANY of the patterns 鈥?useful for snake_case/camelCase/PascalCase variants in one call). " +
    "Smart case: an all-lowercase pattern is matched case-insensitively unless `-i` is set explicitly. " +
    "Defaults: returns up to 100 results overall and 15 matching lines per file in content mode; " +
    "individual lines longer than 2000 chars are truncated. " +
    "Skips common build / cache directories (node_modules, .git, dist, target, .venv, etc.).",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        description:
          "Regex pattern, or an array of regex patterns combined with OR logic. " +
          "Plain identifiers are best 鈥?keep regex simple to avoid 0 matches.",
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
        type: "string",
        description: "Filename glob filter (e.g. \"*.ts\", \"*.{ts,tsx}\").",
      },
      type: {
        type: "string",
        description: "File type filter by extension (e.g. \"js\", \"py\", \"ts\").",
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
// Background shell tools (tracked by Session)
// ------------------------------------------------------------------

export const BASH_BACKGROUND_TOOL: ToolDef = {
  name: "bash_background",
  description:
    "Start a background shell command tracked by the Session. " +
    "Use for dev servers, watchers, and long-running commands whose output you want to inspect later.\n\n" +
    "Don't leave zombie shells behind: when a background shell is no longer needed for your work " +
    "AND has no value to the user, remember to kill_shell it. The exception is processes the user " +
    "benefits from directly 鈥?a dev server they are clicking around in (`npm run dev`, `vite`) " +
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

export const BASH_OUTPUT_TOOL: ToolDef = {
  name: "bash_output",
  description:
    "Read output from a tracked background shell. " +
    "By default, returns unread output since the last bash_output call for that shell. " +
    "Use tail_lines to inspect recent output without advancing the unread cursor.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Tracked shell ID." },
      tail_lines: {
        type: "integer",
        description: "Optional: return the last N lines without advancing unread state.",
      },
      max_chars: {
        type: "integer",
        description: "Optional max characters to return (default 30000, cap 80000).",
      },
    },
    required: ["id"],
  },
  summaryTemplate: "{agent} is reading background shell output",
  tuiPolicy: { partialReveal: { completeArgs: ["id"] } },
};

export const KILL_SHELL_TOOL: ToolDef = {
  name: "kill_shell",
  description:
    "Terminate one or more tracked background shells. " +
    "The signal is sent to the entire process group so children (npm 鈫?vite, etc.) are killed in full. " +
    "After kill the shell entry stays so you can read its final log via bash_output, but the process is gone 鈥?" +
    "killed shells do not auto-restart, and HMR / file-watching stops. " +
    "You can reuse the same id in a new bash_background once the prior shell has stopped.",
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
// Exports: tool lists
// ------------------------------------------------------------------

export const BASIC_TOOLS: ToolDef[] = [
  READ,
  LIST,
  GLOB,
  GREP,
  EDIT,
  WRITE,
  BASH,
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  TIME,
  WEB_SEARCH,
  WEB_FETCH,
];

export const BASIC_TOOLS_MAP: Record<string, ToolDef> = Object.fromEntries(
  BASIC_TOOLS.map((t) => [t.name, t]),
);

// ======================================================================
// Tool executors
// ======================================================================

// ------------------------------------------------------------------
// read_file
// ------------------------------------------------------------------

async function toolReadFile(
  filePath: string,
  startLine?: number,
  endLine?: number,
  artifactsDir?: string,
  supportsMultimodal?: boolean,
  maxLineChars?: number,
): Promise<string | ToolResult> {
  const sensitiveReason = getSensitiveFileReadReason(filePath);
  if (sensitiveReason) {
    return `ERROR: Access to sensitive file is blocked by default: ${filePath} (${sensitiveReason}).`;
  }

  if (!existsSync(filePath)) {
    return `ERROR: File not found: ${filePath}`;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!stat.isFile()) {
    return `ERROR: Not a file: ${filePath}`;
  }

  // --- Image file handling ---
  const [isImage] = classifyFile(filePath);
  if (isImage) {
    if (!supportsMultimodal) {
      return `ERROR: Cannot read image file: current model does not support multimodal input. File: ${filePath}`;
    }
    if (stat.size > READ_MAX_IMAGE_SIZE) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      return `ERROR: Image too large (${sizeMB} MB, limit ${READ_MAX_IMAGE_SIZE / 1024 / 1024} MB).`;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
    try {
      const raw = readFileSync(filePath);
      const b64Data = raw.toString("base64");
      const sizeFmt = stat.size < 1024
        ? `${stat.size} B`
        : stat.size < 1024 * 1024
          ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
      const description = `[Image: ${path.basename(filePath)} | ${mediaType} | ${sizeFmt}]`;
      return new ToolResult({
        content: description,
        contentBlocks: [
          { type: "text", text: description },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: b64Data,
            },
          },
        ],
      });
    } catch (e) {
      return `ERROR: Failed to read image: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (stat.size > READ_MAX_FILE_SIZE) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `ERROR: File too large (${sizeMB} MB, limit ${READ_MAX_FILE_SIZE / 1024 / 1024} MB).`;
  }

  const isProjectedDocument = isProjectedDocumentPath(filePath);

  let text: string;
  let mtimeMs = Math.trunc(stat.mtimeMs);
  let sizeBytes = stat.size;
  let headerPrefix = "";
  try {
    if (isProjectedDocument) {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);
      text = view.text;
      mtimeMs = view.mtimeMs;
      sizeBytes = view.sizeBytes;
      headerPrefix =
        `[Auto-extracted Markdown view of ${path.basename(filePath)} (${projectedDocumentLabel(filePath)} source) | ` +
        `original_path=${filePath}]` + "\n";
    } else {
      text = readFileSync(filePath, { encoding: "utf-8" });
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  const lines = text.split(/\r?\n/);
  // Keep trailing newline semantics: if file ends with \n the last split
  // element is "" but that represents "no extra line".
  const total = lines.length;
  let start = startLine ?? 1;
  let end = endLine == null || endLine === -1 ? total : endLine;

  if (start < 1) return `ERROR: start_line must be >= 1, got ${start}.`;
  if (start > total) return `ERROR: start_line ${start} exceeds total lines (${total}).`;
  if (end > total) end = total;
  if (end < start) return `ERROR: end_line (${end}) < start_line (${start}).`;

  // Apply line limit
  if (end - start + 1 > READ_MAX_LINES) {
    end = start + READ_MAX_LINES - 1;
  }

  let selected = lines.slice(start - 1, end);

  // Per-line truncation for runaway minified lines. The cap is overridable
  // per call so a truncated long line can be recovered in-tool instead of
  // through shell pipelines.
  const lineCap = Math.min(
    Math.max(maxLineChars ?? READ_MAX_LINE_CHARS, READ_LINE_CHARS_FLOOR),
    READ_LINE_CHARS_CEILING,
  );
  let lineTrimCount = 0;
  let longestLineChars = 0;
  selected = selected.map((line) => {
    if (line.length > lineCap) {
      lineTrimCount += 1;
      longestLineChars = Math.max(longestLineChars, line.length);
      return truncateLine(line, lineCap);
    }
    return line;
  });

  // Apply character limit (counts post-line-trim characters)
  let charCount = 0;
  let truncatedAtLine: number | null = null;
  for (let i = 0; i < selected.length; i++) {
    charCount += selected[i].length + 1; // +1 for newline
    if (charCount > READ_MAX_CHARS) {
      selected = selected.slice(0, i);
      truncatedAtLine = start + i; // 1-indexed line that exceeded the limit
      end = start + i - 1; // last fully included line
      break;
    }
  }

  let result =
    headerPrefix +
    `[Lines ${start}-${end} of ${total} | mtime_ms=${mtimeMs} | size_bytes=${sizeBytes}]\n` +
    selected.join("\n");

  if (truncatedAtLine !== null) {
    result +=
      `\n\n[WARNING: Reached ${READ_MAX_CHARS.toLocaleString()} character limit at line ` +
      `${truncatedAtLine}. Showing lines ${start}-${end} ` +
      `(${end - start + 1} complete lines). ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  } else if (end < total) {
    result +=
      `\n\n[Output truncated at ${READ_MAX_LINES} lines. ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  }

  if (lineTrimCount > 0) {
    const plural = lineTrimCount === 1 ? "" : "s";
    const wasWere = lineTrimCount === 1 ? "was" : "were";
    if (longestLineChars <= READ_LINE_CHARS_CEILING) {
      // Recoverable in-tool: re-reading with a larger cap shows the full line.
      result +=
        `\n\n[Note: ${lineTrimCount} line${plural} exceeded ${lineCap} chars and ${wasWere} truncated ` +
        `(longest is ${longestLineChars} chars). ` +
        `Re-read with max_line_chars=${longestLineChars} to see ${lineTrimCount === 1 ? "it" : "them"} in full; ` +
        `the ${READ_MAX_CHARS.toLocaleString()}-character per-call budget still applies.]`;
    } else {
      // A line this long cannot fit the per-call char budget at all, so point
      // the model at a read-class shell escape hatch. The command and quoting
      // depend on the resolved shell 鈥?head/tail/cut don't exist under
      // PowerShell and its single-quote escaping differs 鈥?so render a
      // shell-appropriate hint. Use the full absolute path so the model can
      // paste it verbatim from any working directory.
      const isPwsh = shell.kind === "pwsh" || shell.kind === "powershell";
      let escapeHatch: string;
      if (isPwsh) {
        const psPath = filePath.replace(/'/g, "''");
        // @(...) forces an array even for a single-line/minified file 鈥?        // without it Get-Content returns a bare string, indexing yields a
        // [char], and .Substring throws. This windowing form may prompt for
        // approval (it's not on the pre-approved read list like the bash
        // pipeline below).
        escapeHatch =
          `run \`@(Get-Content '${psPath}')[LINE_NUM - 1].Substring(START_INDEX, LENGTH)\` ` +
          `(START_INDEX is 0-based; may prompt for approval).`;
      } else {
        const safePath = filePath.replace(/'/g, "'\\''");
        escapeHatch =
          `use bash: \`head -n LINE_NUM '${safePath}' | tail -n 1 | cut -c FROM-TO\` ` +
          `(head/tail/cut are pre-approved, no permission prompt).`;
      }
      result +=
        `\n\n[Note: ${lineTrimCount} line${plural} exceeded ${lineCap} chars and ${wasWere} truncated ` +
        `(longest is ${longestLineChars} chars 鈥?too long for the ${READ_MAX_CHARS.toLocaleString()}-character per-call budget). ` +
        `To read a slice of a specific long line, ${escapeHatch}]`;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// list_dir
// ------------------------------------------------------------------

interface ListDirOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function toolListDir(dirPath = ".", opts?: Partial<ListDirOptions>): Promise<string> {
  const options: ListDirOptions = {
    maxDepth: Math.min(Math.max(opts?.maxDepth ?? LIST_MAX_DEPTH_DEFAULT, 1), LIST_MAX_DEPTH_CAP),
    maxEntries: Math.min(Math.max(opts?.maxEntries ?? LIST_MAX_ENTRIES_DEFAULT, 1), LIST_MAX_ENTRIES_CAP),
    includeHidden: opts?.includeHidden ?? false,
  };

  if (!existsSync(dirPath)) {
    return `ERROR: Directory not found: ${dirPath}`;
  }
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return `ERROR: Not a directory: ${dirPath}`;
  }

  const lines: string[] = [];
  let truncated = false;
  let skippedDirs = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > options.maxDepth) return;
    if (lines.length >= options.maxEntries) { truncated = true; return; }

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Stat entries first, then apply directory-only exclusion. A regular
    // file named "build" or "dist" should still be shown 鈥?only same-named
    // *directories* are skipped.
    const candidates: string[] = [];
    for (const name of entries) {
      if (!options.includeHidden && isHiddenName(name)) continue;
      candidates.push(name);
    }

    const withStats = (await Promise.all(
      candidates.map(async (name) => {
        const full = path.join(dir, name);
        let isDir = false;
        let size = 0;
        let statOk = false;
        try {
          const st = await fs.stat(full);
          isDir = st.isDirectory();
          size = st.size;
          statOk = true;
        } catch {
          // inaccessible
        }
        return { name, full, isDir, size, statOk };
      }),
    ))
      .filter((entry) => {
        // Skip excluded directories only after we confirm it IS a directory.
        // If stat failed but the name matches the exclude list, keep the
        // conservative "skip" behaviour 鈥?almost certainly an inaccessible
        // node_modules / target / etc. rather than a regular file.
        const excludedByName = isExcludedDirName(entry.name);
        if (excludedByName && (entry.isDir || !entry.statOk)) {
          skippedDirs += 1;
          return false;
        }
        return true;
      })
      // Sort: directories first, then files, alphabetical
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of withStats) {
      if (lines.length >= options.maxEntries) { truncated = true; return; }
      if (entry.isDir) {
        lines.push(`${prefix}${entry.name}/`);
        await walk(entry.full, prefix + "  ", depth + 1);
      } else {
        lines.push(`${prefix}${entry.name}  [${formatFileSize(entry.size)}]`);
      }
    }
  }

  await walk(dirPath, "", 0);

  if (lines.length === 0) {
    return skippedDirs > 0
      ? `(empty after skipping ${skippedDirs} excluded director${skippedDirs === 1 ? "y" : "ies"})`
      : "(empty directory)";
  }

  let output = lines.join("\n");
  const notices: string[] = [];
  if (truncated) {
    const suggestion = Math.min(options.maxEntries * 4, LIST_MAX_ENTRIES_CAP);
    if (suggestion > options.maxEntries) {
      notices.push(`Output truncated at ${options.maxEntries} entries 鈥?pass max_entries=${suggestion} or narrow the path.`);
    } else {
      // Already at the cap; raising max_entries won't help.
      notices.push(`Output truncated at ${options.maxEntries} entries (cap reached) 鈥?narrow the path or use glob/grep instead.`);
    }
  }
  if (skippedDirs > 0) {
    notices.push(`Skipped ${skippedDirs} excluded director${skippedDirs === 1 ? "y" : "ies"} (node_modules, .git, dist, etc.).`);
  }
  if (notices.length > 0) {
    output += "\n\n" + notices.map((n) => `[${n}]`).join("\n");
  }
  return output;
}


interface FileVersionSnapshot {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  ino?: number;
  dev?: number;
  mode?: number;
}

class FileVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileVersionConflictError";
  }
}

function getFileVersionSnapshot(filePath: string): FileVersionSnapshot {
  if (!existsSync(filePath)) return { exists: false };
  const st = statSync(filePath);
  return {
    exists: true,
    mtimeMs: Math.trunc(st.mtimeMs),
    size: st.size,
    ino: typeof st.ino === "number" ? st.ino : undefined,
    dev: typeof st.dev === "number" ? st.dev : undefined,
    mode: st.mode,
  };
}

function sameFileVersion(a: FileVersionSnapshot, b: FileVersionSnapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

function validateExpectedMtime(
  filePath: string,
  expectedMtimeMs: number | undefined,
  current: FileVersionSnapshot,
): void {
  if (expectedMtimeMs == null) return;
  if (!current.exists) return; // new file 鈥?mtime guard is meaningless
  if (current.size === 0) return; // empty file 鈥?nothing to protect
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new FileVersionConflictError(
      `File changed since last read (mtime conflict): ${filePath} ` +
      `(expected ${expectedMtimeMs}, current ${current.mtimeMs}).`,
    );
  }
}

function fileWriteLockKey(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function withFileWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = fileWriteLockKey(filePath);
  const previous = FILE_WRITE_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  FILE_WRITE_LOCKS.set(key, chain);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (FILE_WRITE_LOCKS.get(key) === chain) {
      FILE_WRITE_LOCKS.delete(key);
    }
  }
}

// ------------------------------------------------------------------
// edit_file
// ------------------------------------------------------------------

async function toolEditFileAppend(
  filePath: string,
  appendStr: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    let before: string;
    try {
      before = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const totalLineCount = countFileLines(before);
    // Re-encode the appended text to the file's existing EOL so appending
    // model-authored LF text to a CRLF file doesn't seed mixed line
    // endings (the same churn write_file/edit_file guard against).
    const finalContent = before + reencodeEol(appendStr, detectFileEol(before));

    const beforeLines = before.length > 0 ? before.split("\n") : [];
    const afterLines = finalContent.length > 0 ? finalContent.split("\n") : [];
    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(beforeLines, afterLines, filePath, filePath),
    );

    const fileModifyData = buildAppendDisplayData(filePath, appendStr, totalLineCount);

    try {
      await atomicWriteTextFile(filePath, finalContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: Appended ${appendStr.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        isAppend: true,
        lineCount: afterLines.length,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
        fileMutation: buildFileMutation(filePath, before, finalContent, true),
      },
    });
  });
}

// ------------------------------------------------------------------
// edit_file multi-edit
// ------------------------------------------------------------------

/** Find every occurrence of needle in haystack as character offsets. */
function findAllOffsets(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/**
 * Sorted list of every newline offset in `content`. Pair with
 * `offsetToLineWithIndex` to convert character offsets to line numbers in
 * O(log n) per query 鈥?used by edit_file's ambiguous-match error path to
 * avoid scanning the file once per duplicate match.
 */
function buildNewlineIndex(content: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") out.push(i);
  }
  return out;
}

/** Convert a character offset to a 1-indexed line number via a pre-built newline index. */
function offsetToLineWithIndex(newlineIndex: readonly number[], offset: number): number {
  // Count of newlines strictly before `offset` (binary search).
  let lo = 0;
  let hi = newlineIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (newlineIndex[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** Truncate a snippet for inclusion in error messages. */
function snippetFor(s: string, maxLen = 60): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "鈥? : s;
}

/**
 * The dominant line ending of a file's contents, by majority vote.
 * A file is treated as CRLF only when CRLF lines outnumber lone-LF lines.
 * "Any CRLF present" was too aggressive: a single stray CRLF in an
 * otherwise-LF file would force the model's LF old_str to CRLF and then
 * match nothing 鈥?the edit silently fails while read_file shows LF-only
 * content, so the model can't see the CR and can't self-correct.
 */
function detectFileEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const loneLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > loneLf ? "\r\n" : "\n";
}

/**
 * Re-encode a string's line endings to the target file's convention.
 * read_file presents content as LF-only (it strips CR), so a multi-line
 * old_str copied from that output is LF even when the file on disk is
 * CRLF 鈥?a literal byte match would then never succeed. Normalizing
 * CRLF鈫扡F first makes this idempotent regardless of what the caller
 * passed. Applied to new_str too, so a replacement preserves the file's
 * existing EOL instead of seeding lone-LF lines into a CRLF file.
 */
function reencodeEol(s: string, eol: "\r\n" | "\n"): string {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

async function toolEditFileMulti(
  filePath: string,
  edits: Array<{ old_str: string; new_str: string; replace_all?: boolean }>,
  expectedMtimeMs?: number,
  appendStr?: string,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    let content: string;
    try {
      content = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    // read_file shows LF-only content, so a multi-line old_str echoed
    // back by the model is LF even when the file is CRLF. Re-encode each
    // edit's strings to the file's actual EOL before matching/replacing,
    // so multi-line edits work on CRLF (Windows-authored) files and the
    // replacement keeps the file's line-ending convention.
    const fileEol = detectFileEol(content);

    // Find all matches; validate uniqueness unless replace_all is opted in.
    // No-op edits (old_str === new_str) are rejected so the model doesn't
    // confuse itself with diffs that don't change anything.
    // Lazily build a newline index 鈥?only when we actually need to format
    // an ambiguous-match error. Avoids scanning the file on the happy path.
    let newlineIndex: number[] | null = null;
    const lineOf = (offset: number): number => {
      if (!newlineIndex) newlineIndex = buildNewlineIndex(content);
      return offsetToLineWithIndex(newlineIndex, offset);
    };

    const matches: MatchInfo[] = [];
    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
      const edit = edits[editIdx];
      // Match and replace using the file's EOL; report errors with the
      // model's original (LF) strings so messages stay readable.
      const oldStr = reencodeEol(edit.old_str, fileEol);
      const newStr = reencodeEol(edit.new_str, fileEol);
      if (oldStr === newStr) {
        return (
          `ERROR: edit #${editIdx + 1} has identical old_str and new_str 鈥?` +
          `this is a no-op. Adjust new_str or remove the edit.`
        );
      }
      const offsets = findAllOffsets(content, oldStr);
      if (offsets.length === 0) {
        return `ERROR: edit #${editIdx + 1}: old_str not found in file: ${JSON.stringify(snippetFor(edit.old_str))}`;
      }
      if (offsets.length > 1 && !edit.replace_all) {
        const lines = offsets.map(lineOf);
        const lineList = lines.length > 6
          ? lines.slice(0, 6).join(", ") + `, 鈥?(${lines.length} total)`
          : lines.join(", ");
        return (
          `ERROR: edit #${editIdx + 1}: old_str appears ${offsets.length} times ` +
          `(at lines ${lineList}). ` +
          `Either add more surrounding context to make the match unique, ` +
          `or pass replace_all: true on this edit to replace every occurrence. ` +
          `old_str: ${JSON.stringify(snippetFor(edit.old_str))}`
        );
      }
      // Push every occurrence (single match by default, all matches when replace_all).
      for (const off of offsets) {
        matches.push({
          index: off,
          oldStr,
          newStr,
        });
      }
    }

    // Sort by offset ascending for overlap check
    matches.sort((a, b) => a.index - b.index);

    // Check overlaps
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      if (prev.index + prev.oldStr.length > matches[i].index) {
        return `ERROR: edits overlap at offset ${matches[i].index}`;
      }
    }

    // Apply replacements from bottom to top (reverse offset order)
    let newContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      newContent = newContent.slice(0, m.index) + m.newStr + newContent.slice(m.index + m.oldStr.length);
    }

    // Append always executes last, after all replacements. Re-encode to
    // the file's EOL so an LF append doesn't seed mixed endings in a CRLF
    // file (consistent with the old_str/new_str re-encoding above).
    if (appendStr) {
      newContent += reencodeEol(appendStr, fileEol);
    }

    const totalLineCount = countFileLines(content);
    const hunks = buildMultiEditHunks(content, matches);

    // If append, add an append hunk at the end
    if (appendStr) {
      const appendStartLine = countFileLines(newContent) - countFileLines(appendStr) + 1;
      hunks.push({
        startLine: appendStartLine,
        contextBefore: [],
        deletions: [],
        additions: appendStr.split("\n"),
        contextAfter: [],
      });
    }

    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(
        content.split("\n"),
        newContent.split("\n"),
        filePath,
        filePath,
      ),
    );

    const fileModifyData: FileModifyDisplayData = {
      filePath,
      language: inferLanguageByExt(filePath),
      mode: "replace",
      totalLineCount,
      hunks,
    };

    try {
      await atomicWriteTextFile(filePath, newContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const parts = [`${edits.length} edits applied`];
    if (appendStr) parts.push(`${appendStr.length} chars appended`);
    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: ${parts.join(", ")}. [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
        fileMutation: buildFileMutation(filePath, content, newContent, true),
      },
    });
  });
}

// ------------------------------------------------------------------
// write_file
// ------------------------------------------------------------------

async function toolWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
      const mode = initialVersion.mode;
      const before = initialVersion.exists
        ? readFileSync(filePath, { encoding: "utf-8" })
        : "";

      // Preserve the existing file's line-ending convention. The model
      // composes content with LF (read_file only ever shows LF), so
      // writing it verbatim would silently rewrite a CRLF file to LF 鈥?      // spurious git churn, broken CRLF-expecting toolchains, and a diff
      // that shows every line as changed (before's lines keep `\r`,
      // after's don't, so nothing aligns). Re-encode to the file's
      // native EOL; new files keep the content exactly as authored.
      const finalContent = initialVersion.exists
        ? reencodeEol(content, detectFileEol(before))
        : content;

      const beforeLines = before.length > 0 ? before.split("\n") : [];
      const afterLines = finalContent.length > 0 ? finalContent.split("\n") : [];
      const diffPreview = buildUnifiedDiffPreview(
        simpleUnifiedDiff(
          beforeLines,
          afterLines,
          filePath,
          filePath,
        ),
      );

      const originalTotalLineCount = countFileLines(before);
      const fileModifyData = buildWriteDisplayData(filePath, finalContent, originalTotalLineCount);

      await atomicWriteTextFile(filePath, finalContent, mode, initialVersion);

      const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
      const tuiPreview: Record<string, unknown> = {
        kind: "diff",
        text: diffPreview.text,
        truncated: diffPreview.truncated,
        newContent: finalContent,
      };
      return new ToolResult({
        content: `OK: Wrote ${finalContent.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
        metadata: {
          path: filePath,
          isNewFile: !initialVersion.exists,
          lineCount: afterLines.length,
          tui_preview: tuiPreview,
          fileModifyData,
          fileMutation: buildFileMutation(filePath, before, finalContent, initialVersion.exists),
        },
      });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

async function atomicWriteTextFile(
  filePath: string,
  content: string,
  mode?: number,
  expectedVersion?: FileVersionSnapshot,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${randomUUID()}`,
  );

  let tmpExists = false;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8" });
    tmpExists = true;

    if (mode !== undefined && osCapabilities.supportsPosixPermissions) {
      try {
        await fs.chmod(tmpPath, mode);
      } catch {
        // Best-effort permission preservation
      }
    }

    if (expectedVersion) {
      const currentVersion = getFileVersionSnapshot(filePath);
      if (!sameFileVersion(expectedVersion, currentVersion)) {
        throw new FileVersionConflictError(
          `File changed during write (mtime conflict): ${filePath}. Please re-read and retry.`,
        );
      }
    }

    await fs.rename(tmpPath, filePath);
    tmpExists = false;
  } finally {
    if (tmpExists) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

// ------------------------------------------------------------------
// bash
// ------------------------------------------------------------------

/**
 * Build the env passed to a bash child. Thin re-export of the
 * platform-shell provider so callers don't need to import from
 * `src/platform/`. Kept as a named export for backwards compatibility
 * with existing imports (BackgroundShellManager).
 */
export function buildBashEnv(): NodeJS.ProcessEnv {
  return shell.buildChildEnv();
}

/**
 * Spill a full text payload to a session-scoped temp file. Returns the
 * absolute path. Best-effort: returns null on failure (we don't want a
 * spill failure to mask the original tool result).
 *
 * Keeps a soft cap of `BASH_SPILL_KEEP_LAST` files in the spill directory:
 * before writing, prune the oldest entries (by mtime) to that count 鈭?1.
 * Long sessions could otherwise accumulate dozens of multi-MB log files.
 */
const BASH_SPILL_KEEP_LAST = 32;

function spillOutputToFile(
  baseDir: string,
  prefix: string,
  full: string,
): string | null {
  try {
    const dir = path.join(baseDir, "bash-output");
    mkdirSync(dir, { recursive: true });

    // Prune oldest spill files to keep the directory bounded. Best-effort
    // 鈥?any error here is ignored; spilling is more important than tidiness.
    try {
      const entries = readdirSync(dir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
          const p = path.join(dir, name);
          try { return { p, mtime: statSync(p).mtimeMs }; }
          catch { return null; }
        })
        .filter((e): e is { p: string; mtime: number } => e !== null)
        .sort((a, b) => a.mtime - b.mtime);
      while (entries.length >= BASH_SPILL_KEEP_LAST) {
        const oldest = entries.shift();
        if (!oldest) break;
        try { unlinkSync(oldest.p); } catch { /* ignore */ }
      }
    } catch { /* ignore pruning failure */ }

    const file = path.join(dir, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.log`);
    fsWriteFileSync(file, full, { encoding: "utf-8" });
    return file;
  } catch {
    return null;
  }
}

async function toolBash(
  command: string,
  timeout: number,
  cwd = "",
  opts: { signal?: AbortSignal; spillDir?: string; adoptShell?: AdoptShellFn } = {},
): Promise<string> {
  // Clamp timeout defensively (the dispatcher already validated presence/integer).
  timeout = Math.min(Math.max(1, timeout), BASH_MAX_TIMEOUT);

  // Resolve working directory
  let runCwd: string | undefined;
  if (cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return `ERROR: Working directory does not exist or is not a directory: ${cwd}`;
    }
    runCwd = cwd;
  }

  return new Promise<string>((resolve) => {
    // Shell selection, env filtering, and process-group setup live in
    // src/platform/shell. `killTree` reaps the whole descendant tree
    // so long-running grandchildren (e.g. vite under `npm run dev`)
    // don't leak as orphans.
    const child = shell.spawn({ command, cwd: runCwd });
    const spawnedAt = performance.now();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxBuffer = 10 * 1024 * 1024; // 10 MB

    let resolved = false;
    let cause: "close" | "timeout" | "abort" | "error" = "close";

    const killGroup = () => {
      shell.killTree(child, BASH_TIMEOUT_KILL_SIGNAL);
    };

    const collectPartial = (): string => {
      const out = Buffer.concat(stdoutChunks).toString("utf-8");
      const err = Buffer.concat(stderrChunks).toString("utf-8");
      // On the timeout / abort path, each stream is truncated at `half`
      // (not BASH_MAX_OUTPUT_CHARS), since we have two streams to fit
      // inside the overall budget. So the spill check must use `half` too
      // 鈥?otherwise a 150K-stdout command that times out loses 50K of
      // output silently because total < BASH_MAX_OUTPUT_CHARS.
      const half = Math.floor(BASH_MAX_OUTPUT_CHARS / 2);
      const parts: string[] = [];
      if (out) parts.push(`PARTIAL STDOUT:\n${truncateMiddle(out, half)}`);
      if (err) parts.push(`PARTIAL STDERR:\n${truncateMiddle(err, half)}`);
      const willTruncate = out.length > half || err.length > half;
      if (opts.spillDir && willTruncate) {
        const full =
          (out ? `==== STDOUT ====\n${out}\n` : "") +
          (err ? `==== STDERR ====\n${err}\n` : "");
        const spill = spillOutputToFile(opts.spillDir, "bash-partial", full);
        if (spill) parts.push(`Full untruncated output saved to: ${spill}`);
      }
      return parts.join("\n");
    };

    const finish = (text: string, keepStdio = false) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Release Node's references to the pipe file descriptors so the
      // parent process doesn't hold them open waiting for a late `close`.
      // Skipped on the background hand-off path: the shell manager owns
      // the child's stdio from that point on.
      if (!keepStdio) {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        try { child.stdin?.destroy(); } catch {}
      }
      resolve(text);
    };

    // Timeout hand-off: the command is NOT killed 鈥?it keeps running as a
    // tracked background shell. Output captured so far seeds the shell log;
    // from here on the shell manager owns the child's stdio. stdin is
    // closed (EOF) so commands stuck waiting for input get an honest "no
    // input is coming" signal and usually exit on their own.
    const handoffToBackground = (): boolean => {
      if (resolved || !opts.adoptShell) return false;
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      const out = Buffer.concat(stdoutChunks).toString("utf-8");
      const err = Buffer.concat(stderrChunks).toString("utf-8");
      const seedOutput =
        (out ? `==== STDOUT (sync phase) ====\n${out}\n` : "") +
        (err ? `==== STDERR (sync phase) ====\n${err}\n` : "");
      let adopted: { id: string; logPath: string };
      try {
        adopted = opts.adoptShell({
          child,
          command,
          cwd: runCwd ?? process.cwd(),
          seedOutput,
          startedAt: spawnedAt,
        });
      } catch {
        return false; // adoption failed 鈥?caller falls back to the kill path
      }
      try { child.stdin?.destroy(); } catch {}
      const partial = collectPartial();
      const header =
        `MOVED TO BACKGROUND: the command did not finish within ${timeout}s. It was NOT killed 鈥?` +
        `it continues running as background shell '${adopted.id}' (log: ${adopted.logPath}).\n` +
        `Do not re-run it: its side effects are still in progress. Poll with \`bash_output(id="${adopted.id}")\`, ` +
        `wait with \`await_event\`, or stop it with \`kill_shell\` when it is no longer needed.\n` +
        `If the partial output below suggests the command was stuck or waiting for interactive input, ` +
        `remember to kill_shell it rather than leaving a zombie shell behind.`;
      finish(partial ? `${header}\n\n${partial}` : header, /* keepStdio */ true);
      return true;
    };

    const finishEarly = () => {
      const partial = collectPartial();
      const header =
        cause === "timeout"
          ? `ERROR: Command timed out after ${timeout}s and was killed (SIGKILL on process group; ` +
            `background hand-off was unavailable). NOTE: a timeout is NOT automatically a failure 鈥?` +
            `for mutating commands, side effects up to the kill point may have completed. Inspect the ` +
            `partial output and resulting filesystem / state before deciding to retry.`
          : `ERROR: Command was interrupted and killed (SIGKILL on process group) before completing.`;
      finish(partial ? `${header}\n\n${partial}` : header);
    };

    const onAbort = () => {
      cause = "abort";
      killGroup();
      finishEarly();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen < maxBuffer) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      cause = "timeout";
      if (handoffToBackground()) return;
      // No adoption available (standalone executeTool) or adoption failed:
      // fall back to the legacy kill path.
      killGroup();
      finishEarly();
    }, timeout * 1000);

    if (opts.signal) {
      if (opts.signal.aborted) {
        cause = "abort";
        killGroup();
        finishEarly();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      // If timeout/abort already settled, ignore the delayed close.
      if (resolved) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const parts: string[] = [];
      const total = stdout.length + stderr.length;
      const willTruncate =
        stdout.length > BASH_MAX_OUTPUT_CHARS ||
        stderr.length > BASH_MAX_OUTPUT_CHARS;

      if (stdout) {
        parts.push(`STDOUT:\n${truncateMiddle(stdout, BASH_MAX_OUTPUT_CHARS)}`);
      }
      if (stderr) {
        parts.push(`STDERR:\n${truncateMiddle(stderr, BASH_MAX_OUTPUT_CHARS)}`);
      }
      parts.push(`EXIT CODE: ${code ?? 1}`);

      // If output was truncated and a spill dir was provided, persist the
      // full output so the model can read_file the whole thing if needed.
      if (willTruncate && opts.spillDir && total > 0) {
        const full =
          (stdout ? `==== STDOUT ====\n${stdout}\n` : "") +
          (stderr ? `==== STDERR ====\n${stderr}\n` : "");
        const spill = spillOutputToFile(opts.spillDir, "bash", full);
        if (spill) {
          parts.push(
            `Full untruncated output saved to: ${spill}\n` +
            `(${total.toLocaleString()} total chars; use read_file or grep to inspect.)`,
          );
        }
      }
      finish(parts.join("\n"));
    });

    child.on("error", (err) => {
      cause = "error";
      finish(`ERROR: ${err.message}`);
    });
  });
}

// ------------------------------------------------------------------
// diff preview helpers (used by edit_file / write_file)
// ------------------------------------------------------------------

function buildUnifiedDiffPreview(
  diff: string,
): { text: string; truncated: boolean } {
  if (!diff) {
    return { text: "(No textual changes.)", truncated: false };
  }

  type PreviewLine = {
    raw: string;
    oldLine?: number;
    newLine?: number;
  };

  const parsedLines: PreviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("-")) {
      parsedLines.push({ raw, oldLine });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("+")) {
      parsedLines.push({ raw, newLine });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsedLines.push({ raw, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    parsedLines.push({ raw });
  }

  const displayLineFor = (line: PreviewLine): number | undefined => {
    if (line.raw.startsWith("-")) return line.oldLine;
    if (line.raw.startsWith("+")) return line.newLine;
    if (line.raw.startsWith(" ")) return line.newLine;
    return undefined;
  };

  const maxLineNumber = parsedLines.reduce((max, line) => {
    return Math.max(max, displayLineFor(line) ?? 0);
  }, 0);
  const numberWidth = Math.max(String(maxLineNumber || 0).length, 2);

  const formatLine = (line: PreviewLine): string => {
    const displayLine = displayLineFor(line);
    const lineCol = displayLine == null ? "".padStart(numberWidth, " ") : String(displayLine).padStart(numberWidth, " ");
    return `${lineCol} ${line.raw}`;
  };

  // Keep every changed line in the preview. Context omission is already handled
  // upstream by the unified diff hunking logic, which limits unchanged lines
  // around each change instead of globally truncating the rendered preview.
  const text = parsedLines.map(formatLine).join("\n");
  return { text, truncated: false };
}

/**
 * Minimal unified diff: generates a unified diff string from two line arrays.
 */
function simpleUnifiedDiff(
  a: string[],
  b: string[],
  labelA: string,
  labelB: string,
): string {
  // Use a simple LCS-based approach
  const n = a.length;
  const m = b.length;

  // For very large files, fall back to a simpler comparison
  if (n * m > 10_000_000) {
    // Too large for full LCS, just show stats
    return (
      `--- ${labelA}\n+++ ${labelB}\n` +
      `(Files differ: ${n} lines vs ${m} lines, diff too large to compute)`
    );
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find edit script
  const ops: Array<{ type: "equal" | "delete" | "insert"; line: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const contextLines = 3;
  const hunks: string[] = [];
  let hunkStart = -1;
  let hunkLines: string[] = [];
  let aLine = 0;
  let bLine = 0;
  let aStart = 0;
  let bStart = 0;
  let aCount = 0;
  let bCount = 0;
  let lastChangeIdx = -contextLines - 1;

  function flushHunk(): void {
    if (hunkLines.length > 0) {
      hunks.push(
        `@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n` +
        hunkLines.join("\n"),
      );
      hunkLines = [];
    }
  }

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (hunkStart === -1 || idx - lastChangeIdx > contextLines * 2) {
        // Start a new hunk
        flushHunk();
        hunkStart = idx;
        aStart = aLine;
        bStart = bLine;
        aCount = 0;
        bCount = 0;
        // Add leading context
        const ctxStart = Math.max(0, idx - contextLines);
        // We need to recount from ctxStart -- but for simplicity, just
        // include context from current position
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx - lastChangeIdx <= contextLines) {
      if (op.type === "equal") {
        hunkLines.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        hunkLines.push(`-${op.line}`);
        aCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        bCount++;
      }
    }

    if (op.type === "equal" || op.type === "delete") aLine++;
    if (op.type === "equal" || op.type === "insert") bLine++;
  }

  flushHunk();

  if (hunks.length === 0) return "";
  return `--- ${labelA}\n+++ ${labelB}\n${hunks.join("\n")}`;
}

function formatUtcOffset(date: Date): string {
  // getTimezoneOffset returns minutes behind UTC; invert for UTC卤HH:MM.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function toolTime(): string {
  const now = new Date();
  const tzIana = Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  const tzName =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value || "Unknown";
  const offset = formatUtcOffset(now);
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const iso = `${local.replace(" ", "T")}${offset}`;
  return [
    `Current local time: ${local}`,
    `Timezone: ${tzIana} (${tzName}, UTC${offset})`,
    `ISO 8601: ${iso}`,
  ].join("\n");
}

// ======================================================================
// Dispatcher
// ======================================================================

/**
 * Per-session static context captured by the dispatch closures.
 *
 * `signal` is optional here because `executeTool` accepts it in the same
 * ctx object for caller convenience, but it's a per-call runtime value
 * that is extracted and passed to each executor as a separate argument.
 */
/**
 * Hand a live, timed-out synchronous bash process over to the session's
 * background shell manager. Returns the tracked shell's id and log path.
 */
export interface AdoptShellRequest {
  child: import("node:child_process").ChildProcess;
  command: string;
  cwd: string;
  /** Output captured during the synchronous phase, seeded into the shell log. */
  seedOutput: string;
  /** performance.now() timestamp of the original spawn. */
  startedAt: number;
}
export type AdoptShellFn = (req: AdoptShellRequest) => { id: string; logPath: string };

export interface ExecuteToolContext {
  projectRoot?: string;
  externalPathAllowlist?: string[];
  sessionArtifactsDir?: string;
  supportsMultimodal?: boolean;
  signal?: AbortSignal;
  /**
   * When present, a synchronous bash command whose timeout elapses is moved
   * to a tracked background shell instead of being killed.
   */
  adoptShell?: AdoptShellFn;
}

class ToolArgValidationError extends Error {
  toolName: string;
  field: string;

  constructor(toolName: string, field: string, message: string) {
    super(message);
    this.name = "ToolArgValidationError";
    this.toolName = toolName;
    this.field = field;
  }
}

function toolRoot(ctx?: ExecuteToolContext): string {
  return path.resolve(ctx?.projectRoot ?? process.cwd());
}

function formatToolError(toolName: string, err: unknown): string {
  if (err instanceof ToolArgValidationError) {
    return `ERROR: Invalid arguments for ${toolName}: ${err.message}`;
  }
  if (err instanceof SafePathError) {
    const p = err.details.resolvedPath || err.details.requestedPath;
    switch (err.code) {
      case "PATH_OUTSIDE_SCOPE":
        return `ERROR: ${toolName} path is outside the project root boundary: ${err.details.requestedPath}`;
      case "PATH_SYMLINK_ESCAPES_SCOPE":
        return `ERROR: ${toolName} path escapes the project root via a symbolic link: ${err.details.requestedPath}`;
      case "PATH_NOT_FOUND":
        return `ERROR: Path not found: ${p}`;
      case "PATH_NOT_FILE":
        return `ERROR: Not a file: ${p}`;
      case "PATH_NOT_DIRECTORY":
        return `ERROR: Not a directory: ${p}`;
      case "PATH_INVALID_INPUT":
        return `ERROR: ${err.message}`;
      default:
        return `ERROR: ${err.message}`;
    }
  }
  return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

function expectArgsObject(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolArgValidationError(toolName, "(root)", "arguments must be an object.");
  }
  return args;
}

function requiredStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !v.trim()) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a non-empty string.`);
  }
  if (opts?.maxLen !== undefined && v.length > opts.maxLen) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' exceeds max length (${opts.maxLen}).`,
    );
  }
  return v;
}

function optionalStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = args[key];
  if (v == null) return fallback;
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  return v;
}

/**
 * Like `requiredStringArg` but for filesystem paths: after the type check, it
 * unwraps the degenerate markdown auto-link some models emit into a path field
 * (`"[notes.md](http://notes.md)"` 鈫?`"notes.md"`). Only the degenerate case
 * is touched; genuine links are left for the path validator to reject. Apply
 * to path/file arguments only 鈥?never to `content`, which may legitimately
 * contain markdown links.
 */
function requiredPathArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  return coercePathString(toolName, key, requiredStringArg(toolName, args, key, opts));
}

/** Optional-path variant of `requiredPathArg` (see its doc). */
function optionalPathArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = optionalStringArg(toolName, args, key, fallback);
  return v === fallback ? v : coercePathString(toolName, key, v);
}

function optionalIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

/**
 * Like `optionalIntegerArg`, but rejects values < 1 with a clear error
 * instead of silently clamping. Use for any "limit / size / count" param
 * where 0 or negative is meaningless 鈥?otherwise the model gets surprising
 * default-fallback behavior (e.g. `limit: 0` returning the default 200).
 */
function optionalPositiveIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = optionalIntegerArg(toolName, args, key);
  if (v === undefined) return undefined;
  if (v < 1) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' must be >= 1 (got ${v}).`,
    );
  }
  return v;
}

function requiredIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number {
  const v = args[key];
  if (v == null) {
    throw new ToolArgValidationError(toolName, key, `'${key}' is required.`);
  }
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

const READ_ACCESS_KINDS = new Set<PathAccessKind>(["read", "list", "search", "attach"]);

function scopedPath(
  requestedPath: string,
  accessKind: PathAccessKind,
  ctx: ExecuteToolContext | undefined,
  opts: {
    mustExist?: boolean;
    allowCreate?: boolean;
    expectFile?: boolean;
    expectDirectory?: boolean;
  },
): string {
  const baseDir = toolRoot(ctx);
  const attempt = (scopeBaseDir: string): string => safePath({
    baseDir: scopeBaseDir,
    requestedPath,
    cwd: baseDir,
    accessKind,
    mustExist: opts.mustExist,
    allowCreate: opts.allowCreate,
    expectFile: opts.expectFile,
    expectDirectory: opts.expectDirectory,
  }).safePath!;

  try {
    return attempt(baseDir);
  } catch (err) {
    if (!(err instanceof SafePathError)) throw err;
    if (err.code !== "PATH_OUTSIDE_SCOPE" && err.code !== "PATH_SYMLINK_ESCAPES_SCOPE") {
      throw err;
    }

    const allowlist = ctx?.externalPathAllowlist ?? [];
    for (const allowedRoot of allowlist) {
      try {
        return attempt(allowedRoot);
      } catch (inner) {
        if (inner instanceof SafePathError &&
            (inner.code === "PATH_OUTSIDE_SCOPE" || inner.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
          continue;
        }
        throw inner;
      }
    }

    // Read-like operations outside scope: advisor is the sole gate for external reads,
    // executor does not double-enforce.
    if (READ_ACCESS_KINDS.has(accessKind)) {
      const resolved = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(baseDir, requestedPath);
      return resolved;
    }

    throw err;
  }
}

// ------------------------------------------------------------------
// glob executor
// ------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any including slash), `?` (single char),
 * `{a,b}` (alternatives), and literal characters.
 */
function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including slashes
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ matches zero or more directories
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (".+^$|()[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Auto-prepend `**\/` to patterns that don't include a slash, so that
 * `*.ts` matches anywhere in the tree (matches Cursor's glob_file_search
 * behavior 鈥?what the model usually means by a "search by extension").
 */
function normalizeGlobPattern(pattern: string): string {
  if (pattern.includes("/")) return pattern;
  // Already covers anywhere via `**` prefix? Leave alone.
  if (pattern.startsWith("**")) return pattern;
  return "**/" + pattern;
}

/**
 * Match a normalized glob pattern (relative path) using Bun's built-in
 * matcher. Supports `**`, `*`, `?`, `[abc]`, `{a,b}`.
 */
function makeGlobMatcher(pattern: string): (relPath: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  // Bun.Glob is provided by the Bun runtime (>=1.1).
  // Falls back to the local regex implementation if Bun is unavailable
  // (e.g. during type-check or in node-only test environments).
  const BunGlob = (globalThis as unknown as { Bun?: { Glob?: new (p: string) => { match: (s: string) => boolean } } }).Bun?.Glob;
  if (BunGlob) {
    const g = new BunGlob(normalized);
    return (relPath) => g.match(relPath);
  }
  const regex = globToRegex(normalized);
  return (relPath) => regex.test(relPath);
}

async function toolGlob(pattern: string, searchPath: string, limit: number): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }
  const cap = Math.min(Math.max(1, limit), GLOB_MAX_LIMIT);
  const match = makeGlobMatcher(pattern);

  const results: Array<{ path: string; mtime: number }> = [];
  let filesScanned = 0;

  async function walk(dir: string, depth: number, relPrefix: string): Promise<void> {
    if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;
    // Bounded recursion guard: protects against pathological / circular
    // symlink trees that would otherwise keep recursing on directory loops
    // without ever incrementing filesScanned.
    if (depth > GLOB_MAX_DEPTH) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;
      // Hidden names skip universally (files + dirs). Directory-only
      // exclusions (node_modules, dist, target, 鈥? are checked AFTER stat
      // so a regular file with the same name is not silently hidden.
      if (isHiddenName(name)) continue;

      const full = path.join(dir, name);
      const rel = relPrefix ? relPrefix + "/" + name : name;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (isExcludedDirName(name)) continue;
        await walk(full, depth + 1, rel);
      } else if (stat.isFile()) {
        filesScanned++;
        if (match(rel)) {
          results.push({ path: full, mtime: stat.mtimeMs });
        }
      }
    }
  }

  await walk(searchPath, 0, "");

  if (results.length === 0) {
    return "No files found matching the pattern.";
  }

  // Sort by mtime descending (most recently modified first)
  results.sort((a, b) => b.mtime - a.mtime);
  const truncated = results.length > cap;
  const shown = truncated ? results.slice(0, cap) : results;

  let output = shown.map((r) => r.path).join("\n");
  if (truncated) {
    output += `\n\n[Showing ${cap} of ${results.length} matches. Pass limit=${Math.min(cap * 4, GLOB_MAX_LIMIT)} or narrow the pattern to see more.]`;
  }
  if (filesScanned >= GLOB_MAX_FILES_SCANNED) {
    output += `\n\n[Stopped after scanning ${GLOB_MAX_FILES_SCANNED.toLocaleString()} files; results may be incomplete.]`;
  }
  return output;
}

// ------------------------------------------------------------------
// grep executor (enhanced search)
// ------------------------------------------------------------------

interface GrepOptions {
  glob?: string;
  fileType?: string;
  outputMode: "content" | "files_with_matches" | "count";
  afterContext: number;
  beforeContext: number;
  /** undefined = smart-case (auto), true = forced -i, false = forced case-sensitive */
  caseInsensitive: boolean | undefined;
  showLineNumbers: boolean;
  headLimit: number;
  perFileLimit: number;
}

/** Check if a filename matches a simple glob pattern (e.g. "*.ts", "*.{ts,tsx}") */
function matchFileGlob(filename: string, globPattern: string): boolean {
  const regex = globToRegex(globPattern);
  return regex.test(filename);
}

/** Check if file extension matches a type filter */
function matchFileType(filename: string, typeFilter: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext === typeFilter.toLowerCase();
}

async function toolGrep(
  patterns: string[],
  searchPath: string,
  options: GrepOptions,
): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  if (patterns.length === 0) {
    return "ERROR: pattern must be a non-empty string or array of strings.";
  }
  if (patterns.length > SEARCH_MAX_PATTERNS) {
    return `ERROR: Too many patterns (${patterns.length}; max ${SEARCH_MAX_PATTERNS}).`;
  }
  for (const pat of patterns) {
    if (!pat) {
      return "ERROR: Invalid arguments for grep: pattern entries must be non-empty strings.";
    }
    if (pat.length > SEARCH_MAX_PATTERN_LENGTH) {
      return (
        `ERROR: Invalid arguments for grep: 'pattern' exceeds max length ` +
        `(${pat.length} chars, limit ${SEARCH_MAX_PATTERN_LENGTH}).`
      );
    }
    if (/(^|[^\\])\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pat)) {
      return "ERROR: Regex appears too complex/risky (nested quantified group).";
    }
  }

  // Smart case (ripgrep-style): no ASCII uppercase in any pattern 鈬?-i.
  // Note this includes ranges like `[a-z]+` (currently get -i) and
  // letter-free patterns like `\d+` (where -i is a no-op).
  let effectiveCaseInsensitive: boolean;
  if (options.caseInsensitive === undefined) {
    effectiveCaseInsensitive = patterns.every((p) => p === p.toLowerCase());
  } else {
    effectiveCaseInsensitive = options.caseInsensitive;
  }

  // Combine multiple patterns into a single OR regex. For one pattern, use
  // it directly to keep the existing regex semantics intact (capture groups,
  // anchors, etc.). For multiple, wrap each in a non-capturing group so
  // alternation has the right precedence.
  let regex: RegExp;
  try {
    const flags = effectiveCaseInsensitive ? "i" : "";
    if (patterns.length === 1) {
      regex = new RegExp(patterns[0]!, flags);
    } else {
      regex = new RegExp(patterns.map((p) => `(?:${p})`).join("|"), flags);
    }
  } catch (e) {
    return `ERROR: Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }

  const startedAt = Date.now();
  const stats = {
    filesScanned: 0,
    bytesScanned: 0,
    skippedLargeFiles: 0,
    skippedSensitiveFiles: 0,
    depthLimitHits: 0,
    maxFilesHit: false,
    maxBytesHit: false,
    timeoutHit: false,
  };

  // Results storage depends on output mode
  const fileMatches: Array<{ file: string; matches: Array<{ line: number; text: string }>; count: number; truncatedAt?: number }> = [];
  let totalEntries = 0;

  function shouldStop(): boolean {
    if (options.headLimit > 0 && totalEntries >= options.headLimit) return true;
    if (stats.maxFilesHit || stats.maxBytesHit || stats.timeoutHit) return true;
    if (Date.now() - startedAt > SEARCH_MAX_DURATION_MS) {
      stats.timeoutHit = true;
      return true;
    }
    return false;
  }

  function shouldIncludeFile(filename: string): boolean {
    if (options.glob && !matchFileGlob(filename, options.glob)) return false;
    if (options.fileType && !matchFileType(filename, options.fileType)) return false;
    return true;
  }

  async function processFile(filePath: string): Promise<void> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch {
      return;
    }
    // Skip binary files
    const header = raw.subarray(0, 8192);
    if (header.includes(0)) return;

    const text = raw.toString("utf-8");
    const lines = text.split("\n");
    const matchingLines: Array<{ line: number; text: string }> = [];
    const perFileCap = Math.max(1, options.perFileLimit);
    let totalMatchesInFile = 0;
    let truncatedAt: number | undefined;

    for (let i = 0; i < lines.length; i++) {
      if (regex.global || regex.sticky) regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        totalMatchesInFile += 1;
        if (matchingLines.length < perFileCap) {
          matchingLines.push({
            line: i + 1,
            text: truncateLine(lines[i].trimEnd(), SEARCH_LINE_MAX_CHARS),
          });
        } else if (truncatedAt === undefined) {
          truncatedAt = totalMatchesInFile;
        }
      }
    }

    if (matchingLines.length > 0) {
      fileMatches.push({
        file: filePath,
        matches: matchingLines,
        count: totalMatchesInFile,
        truncatedAt,
      });
      // headLimit counts entries (lines for content, files otherwise).
      totalEntries +=
        options.outputMode === "content" ? matchingLines.length : 1;
    }
  }

  async function walkForGrep(dir: string, depth: number): Promise<void> {
    if (shouldStop()) return;
    if (depth > SEARCH_MAX_DEPTH) {
      stats.depthLimitHits += 1;
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (shouldStop()) return;
      // Hidden names skip universally. Excluded-dir names are filtered
      // only after stat to avoid hiding regular files that happen to be
      // named `build` / `dist` / `target` / etc.
      if (isHiddenName(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (isExcludedDirName(name)) continue;
        await walkForGrep(full, depth + 1);
      } else if (stat.isFile()) {
        if (!shouldIncludeFile(name)) continue;
        if (getSensitiveFileReadReason(full)) {
          stats.skippedSensitiveFiles += 1;
          continue;
        }
        if (stats.filesScanned >= SEARCH_MAX_FILES) {
          stats.maxFilesHit = true;
          return;
        }
        stats.filesScanned += 1;

        if (stat.size > SEARCH_MAX_FILE_SIZE) {
          stats.skippedLargeFiles += 1;
          continue;
        }
        if (stats.bytesScanned + stat.size > SEARCH_MAX_TOTAL_BYTES) {
          stats.maxBytesHit = true;
          return;
        }
        stats.bytesScanned += stat.size;

        await processFile(full);
      }
    }
  }

  // Handle single file path
  const pathStat = statSync(searchPath);
  if (pathStat.isFile()) {
    if (shouldIncludeFile(path.basename(searchPath))) {
      await processFile(searchPath);
    }
  } else {
    await walkForGrep(searchPath, 0);
  }

  // Format output based on mode
  let output = "";
  let resultsTruncated = false;
  const { outputMode } = options;

  if (fileMatches.length === 0) {
    output = "No matches found.";
  } else if (outputMode === "files_with_matches") {
    const cap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;
    if (fileMatches.length > cap) {
      resultsTruncated = true;
      output = fileMatches.slice(0, cap).map((f) => f.file).join("\n");
    } else {
      output = fileMatches.map((f) => f.file).join("\n");
    }
  } else if (outputMode === "count") {
    const cap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;
    if (fileMatches.length > cap) {
      resultsTruncated = true;
      output = fileMatches.slice(0, cap).map((f) => `${f.file}:${f.count}`).join("\n");
    } else {
      output = fileMatches.map((f) => `${f.file}:${f.count}`).join("\n");
    }
  } else {
    // content mode 鈥?show matching lines with optional context
    const parts: string[] = [];
    const beforeCtx = options.beforeContext;
    const afterCtx = options.afterContext;
    const showNumbers = options.showLineNumbers;
    const headCap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;

    function pushLine(line: string): boolean {
      if (parts.length >= headCap) {
        resultsTruncated = true;
        return false;
      }
      parts.push(line);
      return true;
    }

    outer:
    for (const fm of fileMatches) {
      if (beforeCtx > 0 || afterCtx > 0) {
        // Need to re-read file for context lines
        let fileLines: string[];
        try {
          fileLines = (await fs.readFile(fm.file, "utf-8")).split("\n");
        } catch {
          continue;
        }

        for (const m of fm.matches) {
          const startL = Math.max(0, m.line - 1 - beforeCtx);
          const endL = Math.min(fileLines.length, m.line + afterCtx);

          for (let li = startL; li < endL; li++) {
            const isMatch = li === m.line - 1;
            const prefix = isMatch ? ">" : " ";
            const lineText = truncateLine(fileLines[li].trimEnd(), SEARCH_LINE_MAX_CHARS);
            const formatted = showNumbers
              ? `${fm.file}:${li + 1}:${prefix} ${lineText}`
              : `${fm.file}:${prefix} ${lineText}`;
            if (!pushLine(formatted)) break outer;
          }
          if (!pushLine("--")) break outer;
        }
      } else {
        // No context 鈥?just matching lines
        for (const m of fm.matches) {
          const formatted = showNumbers
            ? `${fm.file}:${m.line}: ${m.text}`
            : `${fm.file}: ${m.text}`;
          if (!pushLine(formatted)) break outer;
        }
      }
      if (fm.truncatedAt !== undefined) {
        if (!pushLine(`${fm.file}: 鈥?(${fm.count - fm.matches.length} more matches in this file; raise limit_per_file to see them)`)) break;
      }
    }
    output = parts.join("\n");
  }

  // Apply overall character cap (head+tail middle-cut) before notices.
  let outputCharsTruncated = false;
  if (output.length > SEARCH_OUTPUT_CHAR_CAP) {
    output = truncateMiddle(output, SEARCH_OUTPUT_CHAR_CAP);
    outputCharsTruncated = true;
  }

  // Append notices
  const notices: string[] = [];
  if (resultsTruncated) {
    const cap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;
    notices.push(`Reached results cap (${cap}). Narrow the pattern, restrict path/glob, or raise head_limit.`);
  }
  if (outputCharsTruncated) {
    notices.push(`Output exceeded ${SEARCH_OUTPUT_CHAR_CAP.toLocaleString()} chars; head+tail kept, middle dropped.`);
  }
  if (stats.skippedLargeFiles > 0) {
    notices.push(`Skipped ${stats.skippedLargeFiles} large file(s) over ${Math.round(SEARCH_MAX_FILE_SIZE / 1024)} KB.`);
  }
  if (stats.skippedSensitiveFiles > 0) {
    notices.push(`Skipped ${stats.skippedSensitiveFiles} sensitive file(s).`);
  }
  if (stats.depthLimitHits > 0) {
    notices.push(`Depth limit reached in ${stats.depthLimitHits} director${stats.depthLimitHits === 1 ? "y" : "ies"} (max depth ${SEARCH_MAX_DEPTH}).`);
  }
  if (stats.maxFilesHit) {
    notices.push(`Stopped after scanning ${SEARCH_MAX_FILES} files.`);
  }
  if (stats.maxBytesHit) {
    notices.push(`Stopped after scanning ${Math.round(SEARCH_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
  }
  if (stats.timeoutHit) {
    notices.push(`Stopped after ${SEARCH_MAX_DURATION_MS}ms time limit.`);
  }
  if (notices.length > 0) {
    output += "\n\n[Search notices]\n" + notices.map((n) => `- ${n}`).join("\n");
  }
  return output;
}

function createDispatch(ctx?: ExecuteToolContext): Record<string, ToolExecutor> {
  return {
    read_file: (args) => {
      try {
        const a = expectArgsObject("read_file", args);
        const requestedPath = requiredPathArg("read_file", a, "path", { nonEmpty: true });
        let startLine = optionalPositiveIntegerArg("read_file", a, "start_line");
        let endLine = optionalIntegerArg("read_file", a, "end_line");
        const offset = optionalPositiveIntegerArg("read_file", a, "offset");
        const limit = optionalPositiveIntegerArg("read_file", a, "limit");
        const maxLineChars = optionalPositiveIntegerArg("read_file", a, "max_line_chars");
        // offset is an alias for start_line; limit converts to end_line.
        if (startLine == null && offset != null) startLine = offset;
        if (endLine == null && limit != null) {
          const effectiveStart = startLine ?? 1;
          endLine = effectiveStart + Math.max(0, limit - 1);
        }
        const filePath = scopedPath(
          requestedPath,
          "read",
          ctx,
          { mustExist: true, expectFile: true },
        );
        return toolReadFile(
          filePath,
          startLine,
          endLine,
          ctx?.sessionArtifactsDir,
          ctx?.supportsMultimodal,
          maxLineChars,
        );
      } catch (e) {
        return formatToolError("read_file", e);
      }
    },
    list_dir: async (args) => {
      try {
        const a = expectArgsObject("list_dir", args);
        const requestedPath = optionalPathArg("list_dir", a, "path", ".");
        const maxDepth = optionalPositiveIntegerArg("list_dir", a, "max_depth");
        const maxEntries = optionalPositiveIntegerArg("list_dir", a, "max_entries");
        const includeHidden = a["include_hidden"] === true;
        const dirPath = scopedPath(
          requestedPath,
          "list",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolListDir(dirPath, { maxDepth, maxEntries, includeHidden });
      } catch (e) {
        return formatToolError("list_dir", e);
      }
    },
    edit_file: (args) => {
      try {
        const a = expectArgsObject("edit_file", args);
        const requestedPath = requiredPathArg("edit_file", a, "path", { nonEmpty: true });
        const expectedMtimeMs = optionalIntegerArg("edit_file", a, "expected_mtime_ms");
        const appendStr = optionalStringArg("edit_file", a, "append_str", "");
        const editsRaw = a.edits;

        // Validate edits array
        const edits: Array<{ old_str: string; new_str: string; replace_all?: boolean }> = [];
        if (Array.isArray(editsRaw)) {
          for (const item of editsRaw) {
            if (!item || typeof item !== "object") {
              return "ERROR: Each item in edits must be an object with old_str and new_str.";
            }
            const obj = item as Record<string, unknown>;
            if (typeof obj.old_str !== "string" || !obj.old_str) {
              return "ERROR: Each item in edits must have a non-empty old_str.";
            }
            if (typeof obj.new_str !== "string") {
              return "ERROR: Each item in edits must have a new_str.";
            }
            edits.push({
              old_str: obj.old_str,
              new_str: obj.new_str,
              replace_all: obj.replace_all === true,
            });
          }
          if (edits.length === 0) {
            return "ERROR: edits array must not be empty.";
          }
        }

        if (edits.length === 0 && !appendStr) {
          return "ERROR: edit_file requires edits array and/or append_str.";
        }

        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { mustExist: true, expectFile: true },
        );

        // Append-only (no replacements)
        if (edits.length === 0) {
          return toolEditFileAppend(filePath, appendStr, expectedMtimeMs);
        }

        // Edits (possibly combined with append)
        return toolEditFileMulti(filePath, edits, expectedMtimeMs, appendStr || undefined);
      } catch (e) {
        return formatToolError("edit_file", e);
      }
    },
    write_file: (args) => {
      try {
        const a = expectArgsObject("write_file", args);
        const requestedPath = requiredPathArg("write_file", a, "path", { nonEmpty: true });
        const content = requiredStringArg("write_file", a, "content");
        const expectedMtimeMs = optionalIntegerArg("write_file", a, "expected_mtime_ms");
        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { allowCreate: true, expectFile: true },
        );
        return toolWriteFile(filePath, content, expectedMtimeMs);
      } catch (e) {
        return formatToolError("write_file", e);
      }
    },
    bash: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("bash", args);
        const command = requiredStringArg("bash", a, "command", { nonEmpty: true, maxLen: 20_000 });
        const timeout = requiredIntegerArg("bash", a, "timeout");
        const cwdArg = optionalPathArg("bash", a, "cwd", "");
        let cwd = "";
        if (cwdArg.trim()) {
          cwd = scopedPath(
            cwdArg,
            "list",
            ctx,
            { mustExist: true, expectDirectory: true },
          );
        }

        const effectiveCwd = cwd || toolRoot(ctx);
        const backupsDir = path.join(ctx?.sessionArtifactsDir ?? effectiveCwd, "rewind-backups");

        // Pre-exec: detect tracked commands and snapshot state.
        // cd-aware: track effectiveCwd through cd segments so mutation
        // paths resolve correctly. External paths skip tracking.
        const segments = splitCompoundBash(command);
        const preExecStates: Array<{ segmentIndex: number; state: BashPreExecState }> = [];
        const projectRoot = ctx?.projectRoot ?? effectiveCwd;
        {
          let segmentCwd = effectiveCwd;
          for (let i = 0; i < segments.length; i++) {
            const cdTarget = extractCdTargetForBash(segments[i]!);
            if (cdTarget !== null) {
              segmentCwd = path.isAbsolute(cdTarget)
                ? path.resolve(cdTarget)
                : path.resolve(segmentCwd, cdTarget);
              continue;
            }
            // Skip mutation tracking for external paths
            const rel = path.relative(projectRoot, segmentCwd);
            if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
            const state = prepareBashPreExec(segments[i]!, backupsDir, segmentCwd);
            if (state) preExecStates.push({ segmentIndex: i, state });
          }
        }

        const output = await toolBash(command, timeout, cwd, {
          signal: rtCtx?.signal,
          spillDir: ctx?.sessionArtifactsDir,
          adoptShell: ctx?.adoptShell,
        });

        // Post-exec: only record mutations if command succeeded (exit code 0).
        // A timeout hand-off counts as not-finished: the command is still
        // running, so its mutations cannot be snapshotted for rewind.
        const isError = output.startsWith("ERROR:") || output.startsWith("MOVED TO BACKGROUND:");
        if (!isError && preExecStates.length > 0) {
          const entries: BashMutationEntry[] = [];
          for (const { state } of preExecStates) {
            const entry = recordBashPostExec(state);
            if (entry) entries.push(entry);
          }
          if (entries.length > 0) {
            const mutation: BashMutation = { command, entries };
            return new ToolResult({
              content: output,
              metadata: { bashMutation: mutation },
            });
          }
        }

        // Clean up backups if command failed
        if (isError) {
          for (const { state } of preExecStates) {
            if (state.backupPath) {
              try { unlinkSync(state.backupPath); } catch { /* ignore */ }
            }
          }
        }

        return output;
      } catch (e) {
        return formatToolError("bash", e);
      }
    },
    time: (args) => {
      try {
        expectArgsObject("time", args);
        return toolTime();
      } catch (e) {
        return formatToolError("time", e);
      }
    },
    glob: async (args) => {
      try {
        const a = expectArgsObject("glob", args);
        const pattern = requiredStringArg("glob", a, "pattern", { nonEmpty: true });
        const requestedPath = optionalPathArg("glob", a, "path", ".");
        const limit = optionalPositiveIntegerArg("glob", a, "limit") ?? GLOB_DEFAULT_LIMIT;
        const globPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolGlob(pattern, globPath, limit);
      } catch (e) {
        return formatToolError("glob", e);
      }
    },
    grep: async (args) => {
      try {
        const a = expectArgsObject("grep", args);

        // pattern: accept string | string[]
        const patternRaw = a["pattern"];
        let patterns: string[];
        if (typeof patternRaw === "string") {
          if (!patternRaw.trim()) {
            return "ERROR: Invalid arguments for grep: 'pattern' must be a non-empty string.";
          }
          patterns = [patternRaw];
        } else if (Array.isArray(patternRaw)) {
          if (patternRaw.length === 0) {
            return "ERROR: Invalid arguments for grep: 'pattern' array must not be empty.";
          }
          patterns = patternRaw.map((p, idx) => {
            if (typeof p !== "string") {
              throw new ToolArgValidationError("grep", `pattern[${idx}]`, `pattern[${idx}] must be a string.`);
            }
            return p;
          });
        } else {
          return "ERROR: Invalid arguments for grep: 'pattern' must be a string or array of strings.";
        }

        const requestedPath = optionalPathArg("grep", a, "path", ".");
        const searchPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true },
        );
        const globFilter = optionalStringArg("grep", a, "glob", "");
        const fileType = optionalStringArg("grep", a, "type", "");
        const outputMode = optionalStringArg("grep", a, "output_mode", "files_with_matches") as "content" | "files_with_matches" | "count";

        // Context-line aliases: prefer hyphen forms (Cursor convention) but
        // accept word forms because some LLMs translate them automatically.
        const afterCtx =
          optionalIntegerArg("grep", a, "-A") ??
          optionalIntegerArg("grep", a, "after_lines") ?? 0;
        const beforeCtx =
          optionalIntegerArg("grep", a, "-B") ??
          optionalIntegerArg("grep", a, "before_lines") ?? 0;
        const contextCtx =
          optionalIntegerArg("grep", a, "-C") ??
          optionalIntegerArg("grep", a, "context_lines") ?? 0;

        // Smart case: undefined when neither flag is passed (auto), explicit otherwise.
        let caseInsensitive: boolean | undefined;
        if (a["-i"] !== undefined) caseInsensitive = a["-i"] === true;
        else if (a["case_insensitive"] !== undefined) caseInsensitive = a["case_insensitive"] === true;

        const showLineNumbers = a["-n"] !== false && a["line_numbers"] !== false;
        const headLimit = optionalPositiveIntegerArg("grep", a, "head_limit") ?? 0;
        const perFileLimit =
          optionalPositiveIntegerArg("grep", a, "limit_per_file") ?? SEARCH_DEFAULT_PER_FILE_LIMIT;

        return await toolGrep(patterns, searchPath, {
          glob: globFilter || undefined,
          fileType: fileType || undefined,
          outputMode,
          afterContext: contextCtx > 0 ? contextCtx : afterCtx,
          beforeContext: contextCtx > 0 ? contextCtx : beforeCtx,
          caseInsensitive,
          showLineNumbers,
          headLimit,
          perFileLimit,
        });
      } catch (e) {
        return formatToolError("grep", e);
      }
    },
    web_search: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("web_search", args);
        const query = requiredStringArg("web_search", a, "query", { nonEmpty: true });
        const numResults = typeof a["num_results"] === "number" ? a["num_results"] : undefined;
        return toolWebSearch(query, numResults, { signal: rtCtx?.signal });
      } catch (e) {
        return formatToolError("web_search", e);
      }
    },
    web_fetch: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("web_fetch", args);
        const url = requiredStringArg("web_fetch", a, "url", { nonEmpty: true });
        const prompt = optionalStringArg("web_fetch", a, "prompt", "");
        return toolWebFetch(url, prompt || undefined, { signal: rtCtx?.signal });
      } catch (e) {
        return formatToolError("web_fetch", e);
      }
    },
    $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
  };
}

/**
 * Execute a tool by name and return a `ToolResult`.
 *
 * Tool functions may return either a plain `string` (wrapped automatically)
 * or a `ToolResult` with optional action hints, tags, and metadata.
 *
 * `ctx.signal` (optional) is pulled out and passed to the executor as a
 * per-call runtime context; the remaining fields are captured by the
 * dispatch closures as static configuration.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ExecuteToolContext,
): Promise<ToolResult> {
  const fn = createDispatch(ctx)[name];
  if (!fn) {
    return new ToolResult({ content: `ERROR: Unknown tool '${name}'` });
  }
  try {
    const raw = await fn(args, { signal: ctx?.signal });
    if (raw instanceof ToolResult) {
      return raw;
    }
    return new ToolResult({ content: raw });
  } catch (e) {
    return new ToolResult({
      content: `ERROR executing ${name}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
