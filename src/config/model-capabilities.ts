/**
 * 模型能力查找表与能力判定。
 *
 * 模型能力不从随程序发布的目录推断；用户配置的字段优先。
 */

import type { TransportProtocol } from "../thinking/artifact.js";
import { THINKING_LEVEL_LIST } from "./thinking.js";
import { normalizeModelId } from "./model-naming.js";

// ------------------------------------------------------------------
// 模型能力不从随程序发布的目录推断；用户配置的字段优先。
// ------------------------------------------------------------------

/** 保留兼容的能力映射；模型能力来自用户配置。 */
export const KNOWN_CONTEXT_LENGTHS: Record<string, number> = {};

/** 用户未显式声明时不启用多模态能力。 */
export const KNOWN_MULTIMODAL_MODELS: Set<string> = new Set();

/** 保留兼容的网络搜索黑名单；模型能力来自用户配置。 */
export const KNOWN_NO_WEB_SEARCH_MODELS: Set<string> = new Set();

/** Convert the user-facing settings protocol alias to the runtime enum. */
export function runtimeTransportProtocol(protocol: string | undefined): TransportProtocol | undefined {
  switch (protocol) {
    case "anthropic":
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
    case "responses":
      return "responses";
    case "gemini":
    case "gemini-generate-content":
      return "gemini";
    case "openai-chat":
    case "openai-chat-completions":
    case "chat":
      return "chat";
    default:
      return undefined;
  }
}

/** 没有内置模型能力表；扩展缓存能力必须由运行时显式配置。 */
export const KNOWN_EXTENDED_CACHE_MODELS: Set<string> = new Set();

// ------------------------------------------------------------------
// 每个模型的最大输出 token 数
// ------------------------------------------------------------------

/** 用户未显式指定时不限制模型的已知输出上限。 */
export const KNOWN_MAX_OUTPUT_TOKENS: Record<string, number> = {};

/** 解析模型的最大输出 token 数。优先级：已知查找（精确匹配 > 标准化匹配）> undefined */
export function getModelMaxOutputTokens(model: string): number | undefined {
  return KNOWN_MAX_OUTPUT_TOKENS[model]
    ?? KNOWN_MAX_OUTPUT_TOKENS[normalizeModelId(model)];
}

// ------------------------------------------------------------------
// 每个模型的思维链级别
// ------------------------------------------------------------------

/** 保留兼容的思考深度映射；未知模型使用可配置默认档位。 */
export const KNOWN_THINKING_LEVELS: Record<string, string[]> = {};

/** 返回模型可用的思考深度候选；最终支持情况由供应商确认。 */
export function getThinkingLevels(model: string): string[] {
  return KNOWN_THINKING_LEVELS[model]
    ?? KNOWN_THINKING_LEVELS[normalizeModelId(model)]
    // 模型能力由供应商在实际请求时确认；未知模型先展示用户配置的默认档位。
    ?? [...THINKING_LEVEL_LIST];
}

/**
 * 子代理专用思考深度列表：过滤掉 "off"。
 *
 * 子代理模型 pin 必须始终启用思维链。主代理流程仍可通过 getThinkingLevels 选择 "off"
 * （用户覆盖在那里的优先级最高）。
 */
export function getSubAgentThinkingLevels(model: string): string[] {
  return getThinkingLevels(model).filter((l) => l !== "off");
}

/** 返回模型最高（最后一个）思维链级别，非思维链模型返回 undefined */
export function getHighestThinkingLevel(model: string): string | undefined {
  const levels = getThinkingLevels(model);
  return levels.length > 0 ? levels[levels.length - 1] : undefined;
}
/** 解析有效的上下文长度。优先级：显式指定 > 已知查找（精确 > 标准化）> 0 */
export function getContextLength(model: string, contextLength = 0): number {
  if (contextLength > 0) return contextLength;
  return KNOWN_CONTEXT_LENGTHS[model]
    ?? KNOWN_CONTEXT_LENGTHS[normalizeModelId(model)]
    ?? 0;
}

/** 解析多模态支持。优先级：显式指定 > 已知查找（精确 > 标准化）> false */
export function getMultimodalSupport(model: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return KNOWN_MULTIMODAL_MODELS.has(model)
    || KNOWN_MULTIMODAL_MODELS.has(normalizeModelId(model));
}

/** 检查模型是否支持 OpenAI 的扩展 24 小时提示缓存保留 */
export function getExtendedCacheSupport(model: string): boolean {
  return KNOWN_EXTENDED_CACHE_MODELS.has(model)
    || KNOWN_EXTENDED_CACHE_MODELS.has(normalizeModelId(model));
}

/** 解析原生网络搜索支持。优先级：显式指定 > 提供商默认值 > 黑名单 > true */
export function getWebSearchSupport(model: string, explicit?: boolean, provider?: string): boolean {
  if (explicit !== undefined) return explicit;
  // OpenRouter：网络搜索是付费附加功能，默认为 false。
  // 用户可通过配置中 supports_web_search: true 显式启用。
  if (provider === "openrouter") return false;
  if (KNOWN_NO_WEB_SEARCH_MODELS.has(model)
    || KNOWN_NO_WEB_SEARCH_MODELS.has(normalizeModelId(model))) return false;
  return true;
}

// ------------------------------------------------------------------
// 环境变量解析
// ------------------------------------------------------------------

