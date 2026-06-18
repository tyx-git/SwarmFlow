/**
 * Agent 鈥?the core execution unit.
 *
 * An Agent wraps a model + system prompt + tools into a callable unit.
 * Supports both stateless single-shot and stateful multi-turn execution.
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
// Output prefix detection
// ------------------------------------------------------------------

export const NO_REPLY_MARKER = "<NO_REPLY>";

/** Check if model output text is the `<NO_REPLY>` marker. */
export function isNoReply(text: string): boolean {
  return text.trim() === NO_REPLY_MARKER;
}

// ------------------------------------------------------------------
// AgentResult
// ------------------------------------------------------------------

export interface AgentResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  noReply: boolean;
}

// ------------------------------------------------------------------
// Agent class
// ------------------------------------------------------------------

/**
 * A callable intelligent unit: model + system prompt + tools.
 *
 * Supports two construction styles:
 *
 * **Explicit:**
 *   new Agent({ name: "Coder", modelConfig, systemPrompt: "...", tools })
 *
 * **Simplified:**
 *   new Agent({ name: "Coder", role: "...", model: "claude-sonnet", config })
 */
export class Agent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: ToolDef[];
  maxToolRounds: number;
  modelConfig: ModelConfig;
  /** Recipe for dynamic system prompt reassembly. Set by loadTemplate(). */
  promptRecipe?: { templateDir: string; spec: Record<string, unknown>; promptsDirs: string[] };

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

    // Resolve modelConfig
    if (opts.modelConfig) {
      this.modelConfig = opts.modelConfig;
    } else if (opts.model && opts.config) {
      this.modelConfig = opts.config.getModel(opts.model);
    } else if (opts.model) {
      throw new Error(
        "Agent: 'config' is required when using the 'model' shorthand.",
      );
    } else {
      throw new Error(
        "Agent: either 'modelConfig' or 'model'+'config' must be provided.",
      );
    }

    this._provider = createProvider(this.modelConfig);
  }

  /**
   * Create an independent copy of this agent with its own modelConfig
   * and provider instance. Used for multi-session concurrency.
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
   * Replace this agent's model config and recreate the provider.
   * Used for runtime model switching (e.g., /model command).
   * Only safe to call between turns (not while a turn is in progress).
   */
  replaceModelConfig(newConfig: ModelConfig): void {
    this.modelConfig = newConfig;
    this._provider = createProvider(newConfig);
  }

  // ------------------------------------------------------------------
  // Async methods
  // ------------------------------------------------------------------

  /**
   * Single-shot async execution (stateless).
   *
   * Builds a fresh message list with system prompt + user input,
   * runs the tool loop, and returns the result.
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
   * Run the tool loop with callback-based message management.
   *
   * The caller provides the loop options minus everything the Agent owns
   * (provider, tools, max rounds, agent name, builtin executor fallback).
   * Main agent: backed by structured log.
   * Sub-agents: backed by an ephemeral structured log.
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
 * Tool-loop options owned by the caller. The Agent supplies provider, tools,
 * max rounds, agent name, and the builtin executor fallback itself.
 */
export type AgentRunWithMessagesOptions = Omit<
  ToolLoopOptions,
  "provider" | "tools" | "toolsMap" | "maxRounds" | "agentName" | "builtinExecutor" | "toolExecutors"
> & {
  toolExecutors?: Record<string, ToolExecutor>;
};
