/**
 * Agent — 核心执行单元。
 *
 * Agent 将模型 + system prompt + tools 封装为一个可调用单元。
 * 支持无状态的单次执行和有状态的多轮执行。
 *
 * 两种构造方式：
 *   显式：new Agent({ name, modelConfig, systemPrompt, tools })
 *   简化：new Agent({ name, role, model, config }) — role 作为 systemPrompt
 *
 * Agent 不是单例 — clone() 创建独立实例和独立 provider，支持并发多 Agent 会话而不产生状态渗透。
 */

import type { Config, ModelConfig } from "../config/config.js";
import type { MessageBlock } from "../primitives/context.js";
import type { BaseProvider, ToolDef } from "../providers/base.js";
import { ToolResult } from "../providers/base.js";
import { createProvider } from "../providers/registry.js";
import { executeTool } from "../tools/basic.js";
import type { LogEntry } from "../context/log-entry.js";
import { createEphemeralLogState } from "../context/ephemeral-log.js";
import {
  asyncRunToolLoop,
  type OnToolCallCallback,
  type ToolExecutor,
  type ToolLoopOptions,
  type ToolLoopResult,
} from "./tool-loop.js";

// ------------------------------------------------------------------
// 输出前缀检测
// ------------------------------------------------------------------

/** 某些 provider 发出的"无可见回复"标记（用于 SwarmCoordinator 协调信号）。 */
export const NO_REPLY_MARKER = "<NO_REPLY>";

/** 判断助手输出是否为无回复哨兵。 */
export function isNoReply(text: string): boolean {
  return text.trim() === NO_REPLY_MARKER;
}

// ------------------------------------------------------------------
// AgentResult
// ------------------------------------------------------------------

/** 单次 asyncRun 调用的返回值。 */
export interface AgentResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  /** 模型输出为 NO_REPLY 标记时为 true（蜂群协调信号）。 */
  noReply: boolean;
}

// ------------------------------------------------------------------
// Agent 类
// ------------------------------------------------------------------

/**
 * 可调用智能单元：模型 + system prompt + tools。
 *
 * 构造方式：
 *   显式：new Agent({ name, modelConfig, systemPrompt, tools })
 *   简化：new Agent({ name, role, model, config }) — role 作为 systemPrompt
 *
 * 所有状态均为实例级别。想并发执行请使用 clone()。
 */
export class Agent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: ToolDef[];
  maxToolRounds: number;
  modelConfig: ModelConfig;
  /** 动态 system prompt 重新组装的配方。由 loadTemplate() 设置。 */
  promptRecipe?: { templateDir: string; spec: Record<string, unknown>; promptsDirs: string[] };

  /** 每个实例独立的 provider（不共享）。clone() 会创建自己的 provider。 */
  private _provider: BaseProvider;

  constructor(opts: {
    name: string;
    modelConfig?: ModelConfig;
    systemPrompt?: string;
    tools?: ToolDef[];
    maxToolRounds?: number;
    role?: string;
    model?: string;
    config?: Config;
    description?: string;
  }) {
    this.name = opts.name;
    this.description = opts.description ?? "";
    this.systemPrompt = opts.role && !opts.systemPrompt
      ? opts.role
      : opts.systemPrompt ?? "";
    this.tools = opts.tools ?? [];
    this.maxToolRounds = opts.maxToolRounds ?? 25;

    // 解析 modelConfig
    if (opts.modelConfig) {
      this.modelConfig = opts.modelConfig;
    } else if (opts.model && opts.config) {
      this.modelConfig = opts.config.getModel(opts.model);
    } else if (opts.model) {
      throw new Error(
        "Agent: 使用 'model' 简写时必须提供 'config'。",
      );
    } else {
      throw new Error(
        "Agent: 必须提供 'modelConfig' 或 'model'+'config'。",
      );
    }

    this._provider = createProvider(this.modelConfig);
  }

  /**
   * 创建独立副本，拥有自己的 provider 实例。
   * 用于并发多 Agent 执行而不产生状态渗透。
   */
  clone(): Agent {
    const cloned = new Agent({
      name: this.name,
      description: this.description,
      modelConfig: { ...this.modelConfig },
      systemPrompt: this.systemPrompt,
      tools: [...this.tools],
      maxToolRounds: this.maxToolRounds,
    });
    cloned.promptRecipe = this.promptRecipe;
    return cloned;
  }

  /**
   * 替换 Agent 的模型配置并重建 provider。
   * 用于运行时模型切换（如 /model 命令）。
   * 仅在回合间调用安全（回合进行中不可调用）。
   */
  replaceModelConfig(newConfig: ModelConfig): void {
    this.modelConfig = newConfig;
    this._provider = createProvider(newConfig);
  }

  // ------------------------------------------------------------------
  // 异步方法
  // ------------------------------------------------------------------

  /**
   * 单次执行：构建新消息列表，运行 tool loop，返回结果。
   * 调用之间无持久状态。
   *
   * @param userInput     字符串或预渲染的 MessageBlock
   * @param extraMessages  可选附加消息，在 userInput 之前插入
   * @param toolExecutors  自定义工具实现（覆盖内置工具）
   * @param onToolCall     每个工具执行前调用的钩子
   * @param signal         AbortSignal，用于取消
   */
  async asyncRun(
    userInput: string | MessageBlock,
    extraMessages?: Array<Record<string, unknown>>,
    toolExecutors?: Record<string, ToolExecutor>,
    onToolCall?: OnToolCallCallback,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const rendered = typeof userInput === "string"
      ? userInput
      : userInput.render();

    const initialMessages: Array<Record<string, unknown>> = [
      { role: "system", content: this.systemPrompt },
    ];
    if (extraMessages) {
      initialMessages.push(...extraMessages);
    }
    initialMessages.push({ role: "user", content: rendered });

    const runtime = createEphemeralLogState(initialMessages, {
      requiresAlternatingRoles: this._provider.requiresAlternatingRoles,
    });

    const result = await asyncRunToolLoop({
      provider: this._provider,
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: this.tools.length > 0 ? this.tools : undefined,
      toolExecutors: toolExecutors ?? {},
      maxRounds: this.maxToolRounds,
      agentName: this.name,
      onToolCall,
      builtinExecutor: executeTool,
      signal,
    });

    return {
      text: result.text,
      toolHistory: result.toolHistory,
      totalUsage: result.totalUsage,
      noReply: isNoReply(result.text),
    };
  }

  /**
   * 基于回调的执适用于有状态多轮会话。
   *
   * Agent 拥有 provider、tools、maxRounds、agentName 和内置执行器。
   * 调用方提供 getMessages/appendEntry/allocId
   *（主 Agent 由结构化日志提供，子 Agent 由临时日志提供）。
   */
  async asyncRunWithMessages(opts: AgentRunWithMessagesOptions): Promise<ToolLoopResult> {
    return asyncRunToolLoop({
      ...opts,
      provider: this._provider,
      tools: this.tools.length > 0 ? this.tools : undefined,
      toolExecutors: opts.toolExecutors ?? {},
      maxRounds: this.maxToolRounds,
      agentName: this.name,
      builtinExecutor: executeTool,
    });
  }
}

/**
 * 调用方拥有的 tool-loop 选项。Agent 自身提供 provider、tools、
 * maxRounds、agentName 和内置执行器。
 */
export type AgentRunWithMessagesOptions = Omit<
  ToolLoopOptions,
  "provider" | "tools" | "toolsMap" | "maxRounds" | "agentName" | "builtinExecutor" | "toolExecutors"
> & {
  toolExecutors?: Record<string, ToolExecutor>;
};
