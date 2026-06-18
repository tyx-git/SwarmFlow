/**
 * HookRuntime 鈥?event dispatching and hook evaluation.
 *
 * Matches events to registered hooks, executes them, collects results.
 * Manages additionalContext accumulation for system prompt injection.
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
// HookRuntime
// ------------------------------------------------------------------

export interface HookEvalResult {
  /** Combined decision: "deny" if any hook denied, "allow" otherwise. */
  decision: "allow" | "deny";
  /** Reason from the first denying hook. */
  denyReason?: string;
  /** Updated tool input from the last hook that provided one. */
  updatedInput?: Record<string, unknown>;
  /** Combined additional context from all hooks. */
  additionalContext?: string;
  /** Individual hook results for debugging. */
  details: Array<{ hookName: string; result: HookRunResult }>;
}

export class HookRuntime {
  private _hooks: HookManifest[] = [];

  /** Context accumulated from hook outputs, keyed by injection scope. */
  private _sessionContext: string[] = [];
  private _turnContext: string[] = [];
  private _nextRoundContext: string[] = [];

  /** Replace all registered hooks (called on reload). */
  setHooks(hooks: HookManifest[]): void {
    this._hooks = hooks.filter((h) => !h.disabled);
  }

  get hooks(): readonly HookManifest[] {
    return this._hooks;
  }

  // -- Context management -------------------------------------------

  /**
   * Get accumulated additional context for system prompt injection.
   * Returns combined session + turn + next-round context, or null if empty.
   */
  getAdditionalContext(): string | null {
    const parts = [...this._sessionContext, ...this._turnContext, ...this._nextRoundContext];
    if (parts.length === 0) return null;
    return parts.join("\n\n");
  }

  /** Clear turn-scoped context (called at turn start). */
  clearTurnContext(): void {
    this._turnContext = [];
  }

  /** Clear next-round context (called after it's been consumed). */
  clearNextRoundContext(): void {
    this._nextRoundContext = [];
  }

  /** Clear all context (called on session reset). */
  clearAllContext(): void {
    this._sessionContext = [];
    this._turnContext = [];
    this._nextRoundContext = [];
  }

  // -- Event evaluation ---------------------------------------------

  /**
   * Fire a hook event: match hooks, execute them, collect results.
   * Hooks for the same event run sequentially; first deny wins.
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

      // Handle failure
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

      // Decision (deny short-circuits)
      if (output.decision === "deny" && DECISION_EVENTS.has(event)) {
        result.decision = "deny";
        result.denyReason = output.reason ?? `Denied by hook "${hook.name}"`;
        break;
      }

      // Updated input (last one wins)
      if (output.updatedInput && INPUT_UPDATE_EVENTS.has(event)) {
        result.updatedInput = output.updatedInput;
      }

      // Additional context
      if (output.additionalContext && CONTEXT_EVENTS.has(event)) {
        contextParts.push(output.additionalContext);
      }
    }

    // Accumulate context by event scope
    if (contextParts.length > 0) {
      const combined = contextParts.join("\n\n");
      result.additionalContext = combined;
      this._accumulateContext(event, combined);
    }

    return result;
  }

  // -- Convenience fire-and-forget for observe-only events ----------

  /** Fire an event without waiting for results. For observe-only events. */
  fireAndForget(event: HookEvent, payload: HookPayload): void {
    const matching = this._matchHooks(event, payload);
    for (const hook of matching) {
      runHookCommand(hook, payload).catch((e) => {
        console.warn(`Hook "${hook.name}" fire-and-forget error:`, e);
      });
    }
  }

  // -- Internal -----------------------------------------------------

  private _matchHooks(event: HookEvent, payload: HookPayload): HookManifest[] {
    return this._hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (hook.disabled) return false;
      if (!hook.matcher) return true;

      // Tool name matching 鈥?if hook requires toolNames but event has none, skip
      if (hook.matcher.toolNames) {
        if (!payload.toolName) return false;
        if (!hook.matcher.toolNames.includes(payload.toolName)) return false;
      }

      // Agent ID matching 鈥?if hook requires agentIds but event has none, skip
      if (hook.matcher.agentIds) {
        if (!payload.agentId) return false;
        if (!hook.matcher.agentIds.includes(payload.agentId)) return false;
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
