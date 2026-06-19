/**
 * 系统提示组装器 —— 从各层构建完整的系统提示。
 *
 * 遵循 swarmflow 的模式：代理基础提示 + 提示层。
 *
 * 公式：
 *   systemPrompt =
 *     agent.prompt                    → 来自模板（角色 + 工具 + 知识）
 *     + 记忆层 (AGENTS.md)            → 来自磁盘，每次重新加载时刷新
 *     + 代理模型固定配置               → 来自配置
 *     + 变量渲染                      → {PROJECT_ROOT}/{SESSION_ARTIFACTS}/{SYSTEM_DATA}/{INITIAL_MODEL}/{SESSION_STARTED} → 实际值
 *
 * 所有层在此组装 —— Session 不再做临时的字符串拼接。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSwarmflowHomeDir } from "./lib/home-path.js";

// ------------------------------------------------------------------
// 提示层类型定义
// ------------------------------------------------------------------

export interface PromptLayer {
  /** 层标识 */
  id: string;
  /** 排序序号（越小越靠前） */
  order: number;
  /** 返回该层内容的函数 */
  content: () => string;
}

// ------------------------------------------------------------------
// 提示变量与会话上下文
// ------------------------------------------------------------------

/** 提示模板中可替换的变量 */
export interface PromptVariables {
  /** 项目根路径 */
  projectRoot: string;
  /** 会话产出目录路径 */
  sessionArtifacts: string;
  /** 系统数据目录路径 */
  systemData: string;
  /** ISO timestamp of when this session began (its first message). Stable across resumes. */
  sessionStartedAt?: string;
  /* 会话创建时的模型标识。跨简历和/模型切换稳定。 */
  initialModel?: string;
  /* 将特定于shell的注释注入到工具提示符中（bash vs PowerShell）。 */
  shellNotes?: string;
}

/**
 * 格式化会话开始的锚定行，若时间戳缺失或无效则返回 null。
 *
 * 以运行时本地时区渲染会话开始时间，以便代理自然地进行时间推理。
 * 我们刻意不要求代理对此发表评论 —— 提供事实就足够了；
 * 强迫反应会变成一种习惯性废话。
 */
function formatSessionStartLine(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let tz: string;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    tz = "local time";
  }
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz === "local time" ? undefined : tz,
    }).format(d);
  } catch {
    formatted = d.toISOString();
  }
  return `This conversation began on ${formatted} (${tz}). When you need the current time, call the \`time\` tool.`;
}

/**
 * 将路径变量替换为会话的实际绝对路径。
 *
 * 渲染提示正文中的 `{PROJECT_ROOT}` / `{SESSION_ARTIFACTS}` / `{SYSTEM_DATA}`，
 * 让模型在工具调用示例和指令中看到具体路径，而非可能被原样粘贴的标记。
 * 在同一会话内（以及同一项目的多次会话中），渲染后的正文是稳定的，
 * 因此在各回合之间对缓存友好。
 */
export function renderPromptVariables(prompt: string, vars: PromptVariables): string {
  return prompt
    .replace(/\{PROJECT_ROOT\}/g, vars.projectRoot)
    .replace(/\{SESSION_ARTIFACTS\}/g, vars.sessionArtifacts)
    .replace(/\{SYSTEM_DATA\}/g, vars.systemData)
    .replace(/\{SHELL_NOTES\}/g, vars.shellNotes ?? "")
    .replace(/\{INITIAL_MODEL\}/g, vars.initialModel ?? "unknown")
    .replace(/\{SESSION_STARTED\}/g, buildSessionStartedVar(vars.sessionStartedAt));
}

/**
 * 构建 {SESSION_STARTED} 替换值。
 * 返回带尾换行的格式化行（模板可将其作为独立段落），
 * 若无有效时间戳则返回 ""（占位符及其周围空行将被折叠）。
 */
function buildSessionStartedVar(iso: string | undefined): string {
  const line = formatSessionStartLine(iso);
  return line ? line + "\n" : "";
}

// ------------------------------------------------------------------
// 内置层
// ------------------------------------------------------------------

/**
 * 从全局和项目路径读取 AGENTS.md 持久化记忆文件。
 * 若不存在记忆文件则返回空字符串。
 */
export function readAgentsMemory(projectRoot: string): string {
  const parts: string[] = [];

  const globalPath = join(getSwarmflowHomeDir(), "AGENTS.md");
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8").trim();
      if (content) parts.push(`## Global Memory\n\n${content}`);
    } catch { /* 忽略 */ }
  }

  const projectPath = join(projectRoot, "AGENTS.md");
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf-8").trim();
      if (content) parts.push(`## Project Memory\n\n${content}`);
    } catch { /* 忽略 */ }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 构建列出代理模型固定配置的提示段落。
 */
export function buildAgentModelPinsSection(
  agentModels: Record<string, { provider: string; selection_key: string; model_id: string; thinking_level?: string }>,
): string | null {
  const entries = Object.entries(agentModels);
  if (entries.length === 0) return null;

  const lines = entries.map(([template, model]) => {
    const parts = [`- **${template}**: ${model.model_id}`];
    if (model.thinking_level) parts[0] += ` (thinking: ${model.thinking_level})`;
    return parts[0];
  });

  return [
    "",
    "以下子代理模板已固定了用户指定的模型。",
    "生成这些代理时，请勿指定 `model_level` —— 固定的模型将自动使用：",
    "",
    ...lines,
  ].join("\n");
}

// ------------------------------------------------------------------
// 组装器
// ------------------------------------------------------------------

/** assembleFullSystemPrompt 的配置选项 */
export interface AssembleOptions {
  /** 基础代理提示（来自模板：角色 + 工具 + 知识）。 */
  agentPrompt: string;
  /** 项目根路径（用于 AGENTS.md 和变量渲染）。 */
  projectRoot: string;
  /** 会话产出目录路径。 */
  sessionArtifacts: string;
  /** 系统数据目录路径。 */
  systemData: string;
  /* 此会话开始时的ISO时间戳（它的第一条消息）。在简历中保持稳定。 */
  sessionStartedAt?: string;
  /* 会话创建时的模型标识。跨简历和/模型切换稳定。 */
  initialModel?: string;
  /* 配置中的代理模型引脚（用于模型引脚部分）。 */
  agentModels?: Record<string, { provider: string; selection_key: string; model_id: string; thinking_level?: string }>;
  /* {SHELL_NOTES}变量的特定于shell的注释（bash vs PowerShell）。 */
  shellNotes?: string;
  /* 额外的提示层（钩子，注入转弯等）。 */
  extraLayers?: PromptLayer[];
}

/**
 * 从代理基础提示 + 各层 + 变量组装完整的系统提示。
 *
 * 这是系统提示构建的唯一入口。
 * 在会话初始化和每次重新加载（AGENTS.md 编辑、/reload 等）时调用。
 */
export function assembleFullSystemPrompt(opts: AssembleOptions): string {
  const vars = {
    projectRoot: opts.projectRoot,
    sessionArtifacts: opts.sessionArtifacts,
    systemData: opts.systemData,
    sessionStartedAt: opts.sessionStartedAt,
    initialModel: opts.initialModel,
    shellNotes: opts.shellNotes,
  };

  let prompt = opts.agentPrompt;

  // 层：AGENTS.md 持久化记忆
  const memory = readAgentsMemory(opts.projectRoot);
  if (memory) {
    prompt = prompt.trimEnd() +
      "\n\n---\n\n# Persistent Memory (AGENTS.md)\n\n" +
      memory;
  }

  // 层：代理模型固定配置
  if (opts.agentModels) {
    const pinsSection = buildAgentModelPinsSection(opts.agentModels);
    if (pinsSection) {
      prompt = prompt.trimEnd() + "\n\n" + pinsSection;
    }
  }

  // 层：额外层（钩子、注入回合 —— 未来的扩展点）
  if (opts.extraLayers) {
    const sorted = [...opts.extraLayers].sort((a, b) => a.order - b.order);
    for (const layer of sorted) {
      const content = layer.content();
      if (content) {
        prompt = prompt.trimEnd() + "\n\n" + content;
      }
    }
  }

  // 将路径变量（{PROJECT_ROOT} 等）替换为会话的实际绝对路径。
  // 放在最后运行，以便任何层（AGENTS.md、钩子）中的变量也能被解析。
  prompt = renderPromptVariables(prompt, vars);

  return prompt;
}
