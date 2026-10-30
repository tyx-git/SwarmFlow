import path from "node:path";

import type { ToolCategory } from "./types.js";

const CWD = process.cwd();
const CWD_PREFIX = CWD + path.sep;

/** Shorten absolute paths under the project root to relative paths. */
function shortenPath(p: string): string {
  if (p.startsWith(CWD_PREFIX)) return p.slice(CWD_PREFIX.length);
  if (p === CWD) return ".";
  return p;
}

export interface ToolDisplayProfile {
  category: ToolCategory;
  displayName: string;
  text(args: Record<string, unknown>): string;
  suffix?(resultMeta?: Record<string, unknown>): string;
  inlineResult: { maxLines: number } | false;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function truncateLines(value: unknown, maxLines = 5): string {
  const s = str(value);
  const lines = s.split("\n");
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join("\n") + "\n...";
}

export const TOOL_PROFILES: Record<string, ToolDisplayProfile> = {
  read_file: {
    category: "observe",
    displayName: "Read",
    text: (args) => shortenPath(str(args.path)),
    inlineResult: false,
  },
  list_dir: {
    category: "observe",
    displayName: "List",
    text: (args) => shortenPath(str(args.path, ".")),
    inlineResult: { maxLines: 1 },
  },
  glob: {
    category: "observe",
    displayName: "Glob",
    text: (args) => str(args.pattern),
    inlineResult: { maxLines: 1 },
  },
  grep: {
    category: "observe",
    displayName: "Search",
    text: (args) => {
      const pattern = str(args.pattern);
      const p = str(args.path);
      return p ? `"${pattern}" in ${shortenPath(p)}` : `"${pattern}"`;
    },
    inlineResult: { maxLines: 1 },
  },
  edit_file: {
    category: "modify",
    displayName: "Edit",
    text: (args) => shortenPath(str(args.path)),
    suffix: (meta) => {
      const added = meta?.linesAdded;
      const removed = meta?.linesRemoved;
      if (typeof added === "number" || typeof removed === "number") {
        return `(+${added ?? 0} -${removed ?? 0})`;
      }
      return "";
    },
    inlineResult: { maxLines: 20 },
  },
  write_file: {
    category: "modify",
    displayName: "Write",
    text: (args) => shortenPath(str(args.path)),
    suffix: (meta) => {
      const lines = meta?.lineCount;
      return typeof lines === "number" ? `(${lines} lines)` : "";
    },
    inlineResult: { maxLines: 20 },
  },
  bash: {
    category: "modify",
    displayName: "Run",
    text: (args) => truncateLines(args.command),
    suffix: (meta) => {
      const code = meta?.exitCode;
      return typeof code === "number" ? `(exit ${code})` : "";
    },
    inlineResult: { maxLines: 1 },
  },
  bash_background: {
    category: "modify",
    displayName: "Run",
    text: (args) => truncateLines(args.command),
    inlineResult: false,
  },
  kill_shell: {
    category: "modify",
    displayName: "Kill",
    text: (args) => {
      const ids = args.ids;
      if (Array.isArray(ids)) return `[${ids.length} shells]`;
      return str(args.id);
    },
    inlineResult: false,
  },
  web_search: {
    category: "observe",
    displayName: "WebSearch",
    text: (args) => `"${str(args.query)}"`,
    inlineResult: { maxLines: 1 },
  },
  web_fetch: {
    category: "observe",
    displayName: "Fetch",
    text: (args) => str(args.url),
    inlineResult: { maxLines: 1 },
  },
  task_create: {
    category: "orchestrate",
    displayName: "TaskCreate",
    text: (args) => str(args.subject),
    inlineResult: false,
  },
  task_list: {
    category: "observe",
    displayName: "TaskList",
    text: () => "",
    inlineResult: false,
  },
  task_get: {
    category: "observe",
    displayName: "TaskGet",
    text: (args) => `#${str(args.task_id)}`,
    inlineResult: false,
  },
  task_update: {
    category: "orchestrate",
    displayName: "TaskUpdate",
    text: (args) => {
      const id = str(args.task_id);
      const status = str(args.status);
      return status ? `#${id} -> ${status}` : `#${id}`;
    },
    inlineResult: false,
  },
  task_resume: {
    category: "orchestrate",
    displayName: "TaskResume",
    text: (args) => `#${str(args.task_id)}`,
    inlineResult: false,
  },
  spawn: {
    category: "orchestrate",
    displayName: "Spawn",
    text: (args) => str(args.id),
    inlineResult: false,
  },
  kill_agent: {
    category: "orchestrate",
    displayName: "Kill",
    text: (args) => {
      const ids = args.ids;
      if (Array.isArray(ids)) return `[${ids.length} agents]`;
      return str(args.id);
    },
    inlineResult: false,
  },
  send: {
    category: "orchestrate",
    displayName: "Send",
    text: (args) => str(args.to),
    inlineResult: { maxLines: 1 },
  },
  ask: {
    category: "orchestrate",
    displayName: "Ask",
    text: (args) => {
      const q = str(args.question);
      return q.length > 80 ? q.slice(0, 80) + "..." : q;
    },
    inlineResult: { maxLines: Number.POSITIVE_INFINITY },
  },
  check_status: {
    category: "observe",
    displayName: "Status",
    text: () => "",
    inlineResult: false,
  },
  time: {
    category: "observe",
    displayName: "Time",
    text: () => "",
    inlineResult: false,
  },
  skill: {
    category: "observe",
    displayName: "Skill",
    text: (args) => str(args.name).replace(/\uFEFF/g, "").trim(),
    inlineResult: false,
  },
  await_event: {
    category: "orchestrate",
    displayName: "Wait",
    // 工具已无参数（seconds 已移除）；等待结果由 tool_result 汇报，这里不再回填。
    text: () => "",
    inlineResult: false,
  },
};

export const HIDDEN_TOOLS = new Set<string>();

export function getToolProfile(toolName: string): ToolDisplayProfile {
  return TOOL_PROFILES[toolName] ?? {
    category: "observe" as const,
    displayName: `Using ${toolName}`,
    text: () => "",
    inlineResult: false,
  };
}
