/**
 * HookRuntime — 事件分发与钩子评估器。
 *
 * 将事件与已注册的钩子进行匹配，执行钩子并收集结果。
 * 管理 additionalContext 累积以用于系统提示符注入。
 */

import type {
  HookEvent,
  HookManifest,
  HookPayload,
  HookOutput,
} from "./types.js";
import {
  DECISION_EVENTS,
  CONTEXT_EVENTS,
  INPUT_UPDATE_EVENTS,
} from "./types.js";
import { runHookCommand, type HookRunResult } from "./runner.js";

// ------------------------------------------------------------------
// 钩子运行时
// ------------------------------------------------------------------

export interface HookEvalResult {
  /* 综合决策：如果任何钩子被拒绝，“拒绝”，否则“允许”。 */
  decision: "allow" | "deny";
  /* 理性从第一否定钩起。 */
  denyReason?: string;
  /* 更新了上一个提供工具输入的钩子的工具输入。 */
  updatedInput?: Record<string, unknown>;
  /* 结合来自所有钩子的附加上下文。 */
  additionalContext?: string;
  /* 用于调试的单个钩子结果。 */
  details: Array<{ hookName: string; result: HookRunResult }>;
}

export class HookRuntime {
  private _hooks: HookManifest[] = [];

  /* 上下文从钩子输出中累积，由注入作用域键化。 */
  private _sessionContext: string[] = [];
  private _turnContext: string[] = [];
  private _nextRoundContext: string[] = [];

  /* 替换所有注册的钩子（重载时调用）。 */
  setHooks(hooks: HookManifest[]): void {
    this._hooks = hooks.filter((h) => !h.disabled);
  }

  get hooks(): readonly HookManifest[] {
    return this._hooks;
  }

  // -- 上下文管理 -------------------------------------------

  /**
   * 获取用于系统提示符注入的累积附加上下文。
   * 返回组合的会话 + 回合 + 下一轮上下文，如果为空则返回 null。
   */
  getAdditionalContext(): string | null {
    const parts = [...this._sessionContext, ...this._turnContext, ...this._nextRoundContext];
    if (parts.length === 0) return null;
    return parts.join("\n\n");
  }

  /* 清除回合作用域上下文（在回合开始时调用）。 */
  clearTurnContext(): void {
    this._turnContext = [];
  }

  /* 清除下一轮上下文（在它被消耗后调用）。 */
  clearNextRoundContext(): void {
    this._nextRoundContext = [];
  }

  /* 清除所有上下文（在会话重置时调用）。 */
  clearAllContext(): void {
    this._sessionContext = [];
    this._turnContext = [];
    this._nextRoundContext = [];
  }

  // -- 事件评估 ---------------------------------------------

  /**
   * 触发一个钩子事件：匹配钩子，执行钩子，收集结果。
   * 同一事件的钩子顺序执行；首次拒绝生效。
   */
  async evaluate(
    event: HookEvent,
    payload: HookPayload,
  ): Promise<HookEvalResult> {
    const matching = this._matchHooks(event, payload);

    const result: HookEvalResult = {
      decision: "allow",
      details: [],
    };

    if (matching.length === 0) return result;

    const contextParts: string[] = [];

    for (const hook of matching) {
      const hookResult = await runHookCommand(hook, payload);
      result.details.push({ hookName: hook.name, result: hookResult });

      // 处理失败
      if (!hookResult.success) {
        if (hook.failClosed && DECISION_EVENTS.has(event)) {
          result.decision = "deny";
          result.denyReason = hookResult.error ?? `Hook "${hook.name}" failed (failClosed)`;
          break;
        }
        console.warn(`Hook "${hook.name}" failed: ${hookResult.error}`);
        continue;
      }

      const output = hookResult.output;

      // 决策（拒绝时短路）
      if (output.decision === "deny" && DECISION_EVENTS.has(event)) {
        result.decision = "deny";
        result.denyReason = output.reason ?? `Denied by hook "${hook.name}"`;
        break;
      }

      // 更新的输入（最后一个生效）
      if (output.updatedInput && INPUT_UPDATE_EVENTS.has(event)) {
        result.updatedInput = output.updatedInput;
      }

      // 附加上下文
      if (output.additionalContext && CONTEXT_EVENTS.has(event)) {
        contextParts.push(output.additionalContext);
      }
    }

    // 按事件作用域累积上下文
    if (contextParts.length > 0) {
      const combined = contextParts.join("\n\n");
      result.additionalContext = combined;
      this._accumulateContext(event, combined);
    }

    return result;
  }

  // -- 用于仅观察事件的便捷即发即忘 --------------------------------

  /* 触发事件而不等待结果。对于仅观察的事件。 */
  fireAndForget(event: HookEvent, payload: HookPayload): void {
    const matching = this._matchHooks(event, payload);
    for (const hook of matching) {
      runHookCommand(hook, payload).catch((e) => {
        console.warn(`Hook "${hook.name}" fire-and-forget error:`, e);
      });
    }
  }

  // -- 内部 --------------------------------------------------------

  private _matchHooks(event: HookEvent, payload: HookPayload): HookManifest[] {
    return this._hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (hook.disabled) return false;
      if (!hook.matcher) return true;

      // 工具名称匹配 — 如果钩子需要工具名称但事件没有，则跳过
      if (hook.matcher.toolNames) {
        if (!payload.toolName) return false;
        if (!hook.matcher.toolNames.includes(payload.toolName)) return false;
      }

      // Agent ID 匹配 — 如果钩子需要 agentIds 但事件没有，则跳过
      if (hook.matcher.agentIds) {
        if (!payload.agentId) return false;
        if (!hook.matcher.agentIds.includes(payload.agentId)) return false;
      }

      // 命令名称匹配 — 如果钩子需要 commandNames 但事件没有，则跳过
      if (hook.matcher.commandNames) {
        if (!payload.commandName) return false;
        if (!hook.matcher.commandNames.includes(payload.commandName)) return false;
      }

      return true;
    });
  }

  private _accumulateContext(event: HookEvent, context: string): void {
    switch (event) {
      case "SessionStart":
        this._sessionContext.push(context);
        break;
      case "UserPromptSubmit":
      case "CommandExecute":
        this._turnContext.push(context);
        break;
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure":
        this._nextRoundContext.push(context);
        break;
    }
  }
}
