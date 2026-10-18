/**
 * 系统提示组装器 —— 从各层构建完整的系统提示。
 *
 * 公式（顺序即缓存前缀顺序）：
 *   systemPrompt =
 *     agent.prompt                    → 来自模板（角色 + 工具 + 知识）
 *     + 全局记忆 (MEMORY.md)          → ~/.swarmflow/MEMORY.md
 *     + 项目记忆 (AGENTS.md)          → <projectRoot>/AGENTS.md
 *     + 可用 skills 目录               → 按 name 排序的 name + description
 *     + 占位符渲染                     → {SHELL_NOTES}/{INITIAL_MODEL}
 *
 * 这里只装配“会话内稳定”的内容。运行时的 hooks、任务提醒、工具可用性
 * 通知等动态内容不属于 system prompt，它们由会话投影追加到消息尾部。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getSwarmflowHomeDir } from "./home-path.js";

// ------------------------------------------------------------------
// 预算
// ------------------------------------------------------------------

/** system 外部上下文（记忆 + skills）总预算：32 KiB。 */
export const SYSTEM_CONTEXT_BUDGET_BYTES = 32 * 1024;
/** 全局记忆上限：总预算的 25%。 */
export const GLOBAL_MEMORY_BUDGET_BYTES = 8 * 1024;
/** 项目记忆上限：总预算的 50%。 */
export const PROJECT_MEMORY_BUDGET_BYTES = 16 * 1024;
/** skills 目录上限：总预算的 25%。 */
export const SKILLS_LISTING_BUDGET_BYTES = 8 * 1024;
/**
 * 段落标题与分隔符的预留空间。
 *
 * 预算按“内容字节”分配，标题和 `---` 分隔符会额外占用少量字节；
 * 预留 1 KiB 保证完整 system 不会因为标题开销突破 32 KiB。
 */
const SECTION_OVERHEAD_RESERVE_BYTES = 1024;

/** 全局记忆文件名。 */
export const GLOBAL_MEMORY_FILE = "MEMORY.md";
/** 项目记忆文件名。 */
export const PROJECT_MEMORY_FILE = "AGENTS.md";

// ------------------------------------------------------------------
// 占位符
// ------------------------------------------------------------------

/** 提示模板中仍需要替换的运行时占位符。 */
export interface PromptVariables {
  /* 将特定于 shell 的注释注入到工具提示符中（bash vs PowerShell）。 */
  shellNotes?: string;
}

/**
 * 渲染提示正文中的 `{SHELL_NOTES}`，并清空旧模板里的模型身份占位符。
 *
 * 路径与时间不再注入 system：
 *  - 工作目录由工具执行时的 projectRoot 决定，模型可用 `bash pwd`/`list_dir` 获取；
 *  - 当前时间由 `time` 工具提供；
 *  - 会话工件目录是运行时基础设施，不需要暴露给模型。
 */
export function renderPromptVariables(prompt: string, vars: PromptVariables): string {
  return prompt
    .replace(/\{SHELL_NOTES\}/g, vars.shellNotes ?? "")
    // 旧模板里的模型身份占位符统一清空，不向模型提示供应商或型号。
    .replace(/\{INITIAL_MODEL\}/g, "");
}

// ------------------------------------------------------------------
// 记忆文件
// ------------------------------------------------------------------

/** 读取一个文本文件并 trim；不存在或为空时返回空字符串。 */
function readTrimmed(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** 全局记忆路径（~/.swarmflow/MEMORY.md）。 */
export function globalMemoryPath(homeDir: string = getSwarmflowHomeDir()): string {
  return join(homeDir, GLOBAL_MEMORY_FILE);
}

/**
 * 确保全局记忆文件存在。
 *
 * 首次启动时创建一个空文件；绝不覆盖用户已有内容。创建失败不应阻止
 * 运行时启动（只读 home 也允许继续工作）。
 */
export function ensureGlobalMemoryFile(homeDir: string = getSwarmflowHomeDir()): void {
  const path = globalMemoryPath(homeDir);
  try {
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return;
    console.warn(
      `Unable to initialize global memory at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 读取全局记忆与项目记忆（均未做预算截断）。 */
export function readMemoryFiles(
  projectRoot: string,
  homeDir: string = getSwarmflowHomeDir(),
): { globalContent: string; projectContent: string } {
  return {
    globalContent: readTrimmed(globalMemoryPath(homeDir)),
    projectContent: readTrimmed(join(projectRoot, PROJECT_MEMORY_FILE)),
  };
}

// ------------------------------------------------------------------
// skills 目录
// ------------------------------------------------------------------

/** system 中展示给模型的 skill 条目。 */
export interface SkillListingEntry {
  name: string;
  description: string;
  /** 仅用户可通过 /name 调用；不进入模型可调用列表。 */
  disableModelInvocation?: boolean;
}

/** 按 name 的码元顺序排序，保证跨进程/跨文件系统字节稳定。 */
function compareSkillNames(a: SkillListingEntry, b: SkillListingEntry): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** 将文本截断到不超过 maxBytes（UTF-8），并附加截断标记。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const marker = "\n\n[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    return truncateUtf8Plain(text, maxBytes);
  }

  return truncateUtf8Plain(text, maxBytes - markerBytes) + marker;
}

/** 纯截断，不附加标记；按 Unicode code point 切分，避免拆坏代理对。 */
function truncateUtf8Plain(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(""), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join("");
}

/**
 * 格式化“可用 skills”段落。
 *
 * 只列出模型可调用的 skill；按 name 排序；逐条写入直到预算耗尽。
 * 返回内容包含段落标题，空列表返回空字符串（不生成空标题）。
 */
export function formatSkillsListing(
  skills: readonly SkillListingEntry[],
  maxBytes: number = SKILLS_LISTING_BUDGET_BYTES,
): string {
  const available = skills
    .filter((skill) => !skill.disableModelInvocation)
    .slice()
    .sort(compareSkillNames);

  if (available.length === 0 || maxBytes <= 0) return "";

  const header = "# Available Skills\n\n";
  const headerBytes = Buffer.byteLength(header, "utf8");
  if (headerBytes >= maxBytes) return "";

  const lines: string[] = [];
  let used = headerBytes;
  for (const skill of available) {
    const description = skill.description.replace(/\s+/g, " ").trim();
    const line = `- ${skill.name}: ${description}`;
    const remaining = maxBytes - used;
    if (remaining <= 0) break;

    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes <= remaining) {
      lines.push(line);
      used += lineBytes + 1; // newline
      continue;
    }

    // 单条超预算：截断这一条后停止，避免出现没有名字的残缺行。
    const fitted = truncateUtf8Plain(line, remaining);
    if (fitted.trim().length > 0) lines.push(fitted);
    break;
  }

  return header + lines.join("\n");
}

// ------------------------------------------------------------------
// 组装器
// ------------------------------------------------------------------

/** assembleFullSystemPrompt 的配置选项。 */
export interface AssembleOptions {
  /** 基础代理提示（来自模板：角色 + 工具 + 知识）。 */
  agentPrompt: string;
  /** 项目根路径（用于 AGENTS.md）。 */
  projectRoot: string;
  /** SwarmFlow 主目录（用于 MEMORY.md）；省略时使用 ~/.swarmflow。 */
  homeDir?: string;
  /** 当前会话可用的 skills。 */
  skills?: readonly SkillListingEntry[];
  /* {SHELL_NOTES}变量的特定于shell的注释（bash vs PowerShell）。 */
  shellNotes?: string;
}

/**
 * 从代理基础提示 + 记忆 + skills 组装完整的系统提示。
 *
 * 这是系统提示构建的唯一入口，只在会话初始化与显式 /reload 时调用。
 * 顺序固定为：角色 → 全局 MEMORY.md → 项目 AGENTS.md → skills。
 * 项目 AGENTS.md 位于全局记忆之后，拥有更高的近期权重。
 */
export function assembleFullSystemPrompt(opts: AssembleOptions): string {
  const memory = readMemoryFiles(opts.projectRoot, opts.homeDir);
  const contentBudget = SYSTEM_CONTEXT_BUDGET_BYTES - SECTION_OVERHEAD_RESERVE_BYTES;

  // 预算分配按优先级：项目 AGENTS.md → 全局 MEMORY.md → skills。
  const projectContent = truncateUtf8(
    memory.projectContent,
    Math.min(PROJECT_MEMORY_BUDGET_BYTES, contentBudget),
  );
  const projectBytes = Buffer.byteLength(projectContent, "utf8");

  const globalContent = truncateUtf8(
    memory.globalContent,
    Math.min(GLOBAL_MEMORY_BUDGET_BYTES, Math.max(0, contentBudget - projectBytes)),
  );
  const globalBytes = Buffer.byteLength(globalContent, "utf8");

  const skillsBudget = Math.max(
    0,
    Math.min(SKILLS_LISTING_BUDGET_BYTES, contentBudget - projectBytes - globalBytes),
  );
  const skillsSection = formatSkillsListing(opts.skills ?? [], skillsBudget);

  let prompt = opts.agentPrompt;

  if (globalContent) {
    prompt = prompt.trimEnd() +
      "\n\n---\n\n# Global Memory (MEMORY.md)\n\n" +
      globalContent;
  }

  if (projectContent) {
    prompt = prompt.trimEnd() +
      "\n\n---\n\n# Persistent Memory (AGENTS.md)\n\n" +
      projectContent;
  }

  if (skillsSection) {
    prompt = prompt.trimEnd() + "\n\n---\n\n" + skillsSection;
  }

  // 占位符渲染放在最后，任何层中的 {SHELL_NOTES} 都能被解析。
  prompt = renderPromptVariables(prompt, { shellNotes: opts.shellNotes });

  return prompt;
}
