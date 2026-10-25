/**
 * Token 用量聚合与 system prompt 分段估算（纯计算，不含会话状态）。
 *
 * 会话侧的 memo 缓存仍由 Session 持有；这里只负责"从日志求和"与
 * "按 provider 实际 system prompt 大小缩放估算"两件可独立验证的计算。
 */

import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";

import { estimateEntryTokens } from "../context/token-estimate.js";
import type { LogEntry } from "../context/entry/types.js";
import type { SkillListingEntry } from "../prompts/assembler.js";
import { formatSkillsListing, readMemoryFiles } from "../prompts/assembler.js";
import type { ToolDef } from "../providers/types.js";
import { getPromptLayers, type PromptRecipe } from "../prompts/templates.js";

/** Cumulative usage figures derived from the log's token_update entries. */
export interface UsageStats {
  /** Total inputTokens across every provider call (billed input, re-sent each call). */
  cumulativeInput: number;
  /** Total output tokens (totalTokens - inputTokens) across every provider call. */
  cumulativeOutput: number;
  /** Total cacheReadTokens (the cached slice of cumulativeInput). */
  cumulativeCacheRead: number;
  /** Total uncached input (inputTokens - cacheReadTokens), the uncached slice of cumulativeInput. */
  cumulativeUncached: number;
  /** Estimated fixed prompt: first call's input minus the first user message. */
  systemPromptTotal: number;
  /** Per-section breakdown of systemPromptTotal (ratio-scaled estimates). */
  systemPromptBreakdown: ContextBreakdown;
  firstInput: number;
  firstUserMessageTokens: number;
}

/** Per-section token estimates for the context breakdown. */
export interface ContextBreakdown {
  systemPrompt: number;
  tools: number;
  agentsMd: number;
  skills: number;
  messages: number;
}

/** 日志求和结果：累计用量 + 首轮输入与首条用户消息的 token 数。 */
export interface TokenUsageAggregate {
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeCacheRead: number;
  cumulativeUncached: number;
  firstInput: number;
  firstUserMessageTokens: number;
}

/**
 * 累加日志里每个 token_update 条目，并记录第一条 user 消息的 token 数。
 * 首个非零 input 视为"首轮调用"，用于反推固定 system prompt 的体积。
 */
export interface TokenContribution {
  input: number;
  output: number;
  cacheRead: number;
}

/** 单个 token_update 条目的计费贡献；无效/零输入返回 null。 */
export function tokenUpdateContribution(entry: LogEntry): TokenContribution | null {
  if (entry.type !== "token_update") return null;
  const meta = entry.meta as Record<string, unknown>;
  const input = meta["inputTokens"] as number;
  if (!Number.isFinite(input) || input <= 0) return null;
  const total = (meta["totalTokens"] as number | undefined) ?? input;
  const cacheRead = (meta["cacheReadTokens"] as number | undefined) ?? 0;
  return { input, output: Math.max(0, total - input), cacheRead };
}

export function aggregateTokenUsage(log: readonly LogEntry[]): TokenUsageAggregate {
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let cumulativeCacheRead = 0;
  let cumulativeUncached = 0;
  let firstInput = 0;
  let firstUserMessageTokens = 0;
  let sawFirstUserMessage = false;

  for (const entry of log) {
    if (entry.type === "token_update") {
      const contribution = tokenUpdateContribution(entry);
      if (!contribution) continue;
      cumulativeInput += contribution.input;
      cumulativeOutput += contribution.output;
      cumulativeCacheRead += contribution.cacheRead;
      cumulativeUncached += Math.max(0, contribution.input - contribution.cacheRead);
      if (firstInput === 0) firstInput = contribution.input;
    } else if (
      !sawFirstUserMessage &&
      entry.type === "user_message" &&
      (entry.meta as Record<string, unknown>)["inputKind"] === "user"
    ) {
      firstUserMessageTokens = estimateEntryTokens(entry);
      sawFirstUserMessage = true;
    }
  }

  return {
    cumulativeInput,
    cumulativeOutput,
    cumulativeCacheRead,
    cumulativeUncached,
    firstInput,
    firstUserMessageTokens,
  };
}

/** system prompt 各段的 token 估算（gpt-tokenizer）。 */
export interface PromptSectionEstimates {
  systemPrompt: number;
  tools: number;
  agentsMd: number;
  skills: number;
}

/** 估算所需的输入：角色模板、工具 schema、记忆文件与技能清单。 */
export interface PromptSectionInputs {
  recipe: PromptRecipe | undefined;
  systemPrompt: string;
  toolDefs: readonly ToolDef[];
  projectRoot: string;
  swarmflowHomeDir: string;
  skills: Iterable<SkillListingEntry>;
}

/**
 * 估算 token 数：system prompt 各段、工具文档+schema、AGENTS.md/MEMORY.md、技能清单。
 * 纯函数，调用方负责缓存。
 */
export function estimatePromptSections(input: PromptSectionInputs): PromptSectionEstimates {
  // System Prompt (role body + knowledge —NOT tool docs)
  let estSystemPrompt = 0;
  let estToolDocs = 0;
  if (input.recipe) {
    const layers = getPromptLayers(input.recipe);
    estSystemPrompt = gptEncode(layers.roleBody).length + gptEncode(layers.knowledge).length;
    estToolDocs = gptEncode(layers.toolDocs).length;
  } else {
    estSystemPrompt = gptEncode(input.systemPrompt).length;
  }

  // Tool schemas (ToolDef[] serialized as provider would)
  let estToolSchemas = 0;
  for (const tool of input.toolDefs) {
    estToolSchemas += gptEncode(
      JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    ).length;
  }

  // 记忆层（全局 MEMORY.md + 项目 AGENTS.md）
  const memory = readMemoryFiles(input.projectRoot, input.swarmflowHomeDir);
  const memoryText = [memory.globalContent, memory.projectContent].filter(Boolean).join("\n\n");
  const estAgentsMd = memoryText ? gptEncode(memoryText).length : 0;

  // skills 目录位于 system prompt，不再计入工具 schema
  const skillsListing = formatSkillsListing([...input.skills]);
  const estSkills = skillsListing ? gptEncode(skillsListing).length : 0;

  // Tools = tool docs (inline in prompt) + tool schemas (API tools[])
  const tools = estToolDocs + estToolSchemas;

  return { systemPrompt: estSystemPrompt, tools, agentsMd: estAgentsMd, skills: estSkills };
}

/**
 * 把分段估算按"provider 实际 system prompt / 估算总和"的比例缩放，
 * 使各段之和等于 provider 上报的固定 prompt 体积。
 */
export function scalePromptBreakdown(
  est: PromptSectionEstimates,
  systemPromptTotal: number,
): ContextBreakdown {
  const estTotal = est.systemPrompt + est.tools + est.agentsMd + est.skills;
  const ratio = estTotal > 0 ? systemPromptTotal / estTotal : 0;
  return {
    systemPrompt: Math.round(est.systemPrompt * ratio),
    tools: Math.round(est.tools * ratio),
    agentsMd: Math.round(est.agentsMd * ratio),
    skills: Math.round(est.skills * ratio),
    messages: 0, // filled by the panel from context - systemPromptTotal
  };
}
