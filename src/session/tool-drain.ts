/**
 * 工具调用排空：待执行队列、执行态标记、中断收尾与执行前闸门。
 *
 * 只搬"取出下一个待执行调用、逐个执行、把结果写回日志"这层；
 * 激活循环仍在 Session，通过 host 虚分派调用。
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { ToolPreflightContext, ToolPreflightDecision } from "../agents/tool-loop/types.js";
import type { ToolExecutor } from "../tools/executor-types.js";
import { HookRuntime, type HookPayload } from "../hooks/index.js";
import { ToolGate } from "../tools/runtime.js";
import type { ApprovalRequest } from "../ask.js";
import type { AskRequest } from "../ask.js";
import { createAskRequest, createToolResult as createToolResultEntry } from "../context/entry/factories.js";
import type { LogEntry } from "../context/entry/types.js";
import type { PermissionAdvisor } from "../permissions/index.js";
import { ToolResult } from "../providers/response.js";
import type { Agent } from "../agents/agent.js";
import type { DrainPendingToolCallsResult } from "./turn-types.js";
import type { SessionLog } from "./log.js";

import type { ProgressReporter } from "../logging/progress.js";

/** 工具排空所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface ToolDrainHost {
  primaryAgent: Agent;
  toolGate: ToolGate;
  hookRuntime: HookRuntime;
  onSaveRequest?: () => void | boolean;
  _projectRoot: string;
  _log: LogEntry[];
  _logStore: SessionLog;
  _turnCount: number;
  _agentState: string;
  _activeAsk: AskRequest | null;
  _activeLogEntryId: string | null;
  _pendingTurnState: unknown;
  _permissionAdvisor: PermissionAdvisor;
  _progress?: ProgressReporter;
  _toolExecutors: Record<string, ToolExecutor>;
  _lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  _beforeToolExecute: (ctx: ToolPreflightContext) => Promise<ToolPreflightDecision | void>;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _touchLog(): void;
  _allocateContextId(): string;
  _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined;
  _activeWindowStartIdx(): number;
  _drainInboxAsEntries(): number;
  _hasInboxMessages(): boolean;
  _withTurnLock<T>(fn: () => Promise<T>): Promise<T>;
  _runTurnActivationLoop(signal: AbortSignal | undefined, textAccumulator: { text: string }, reasoningAccumulator: { text: string }): Promise<string>;
  _resumeActivationStage(options?: { signal?: AbortSignal }): Promise<string>;
  _resumeActivationStageInner(options?: { signal?: AbortSignal }): Promise<string>;
  _collectInterruptHints(): string[];
  _handleInterruption(logLen: number, text: string, opts: { activationCompleted: boolean }): void;
  _ensureSessionStartHooks(): Promise<void>;
  _firstPendingToolCall(): { index: number; entry: LogEntry } | null;
  _getArtifactsDirIfAvailable(): string | undefined;
  _setSelfPhase(phase: unknown): void;
  _recordSessionEvent(summary: string): void;
  _recordTurnFailure(err: unknown, signal?: AbortSignal): void;
  _finishCurrentWork(status: "completed" | "interrupted" | "error", interruptHints?: string[]): void;
  _installCurrentTurnSignal(signal?: AbortSignal): {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
    signal: AbortSignal;
  };
  _restoreCurrentTurnSignal(state: {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
  }): void;
  _emitAskRequestedProgress(ask: AskRequest): void;
  // 同簇方法：模块内按 host.X(...) 虚分派调用
  _findEarliestPendingToolCallLogIndex(): number;
  _finalizeDrainInterruptedWork(fromLogIndex: number): void;
  _drainPendingToolCalls(signal?: AbortSignal): Promise<DrainPendingToolCallsResult>;
  _findNextPendingToolCall(): { toolCallId: string; toolName: string; toolArgs: Record<string, unknown>; turnIndex: number; roundIndex: number; agentName: string } | null;
  _updateToolCallExecState(toolCallId: string, state: "not_started" | "running" | "completed" | "failed"): void;
  _isInsideArtifactsDir(rawPath: unknown): boolean;
}
export function findEarliestPendingToolCallLogIndex(host: ToolDrainHost): number {
  return host._firstPendingToolCall()?.index ?? host._log.length;
}

export function finalizeDrainInterruptedWork(host: ToolDrainHost, fromLogIndex: number): void {
  host._handleInterruption(fromLogIndex, "", { activationCompleted: false });

  for (let index = fromLogIndex; index < host._log.length; index += 1) {
    const entry = host._log[index]!;
    if (entry.type !== "tool_call") continue;
    if (entry.turnIndex !== host._turnCount) continue;
    const meta = entry.meta as Record<string, unknown>;
    const execState = meta["toolExecState"];
    if (execState === "running" || execState === "not_started") {
      meta["toolExecState"] = "failed";
    }
  }

  host._agentState = "idle";
  host._activeLogEntryId = null;
  host._setSelfPhase("idle");
  if (!host._activeAsk && host._turnCount > 0) {
    host._finishCurrentWork("interrupted", host._collectInterruptHints());
  }
}

/**
 * Drain pending tool_calls in the current turn (in emission order).
 * For each: gate →execute →append tool_result, updating tool_call meta.
 * Returns a structured result so approval suspension and interruption are
 * not collapsed into the same empty-string resume path.
 *
 * This is the single canonical path for executing tool_calls outside of
 * the streaming tool-loop —used after approval resume and to handle
 * orphan parallel tool_calls.
 */
export async function drainPendingToolCalls(host: ToolDrainHost, signal?: AbortSignal): Promise<DrainPendingToolCallsResult> {
  while (true) {
    if (signal?.aborted) return { kind: "interrupted" };

    const next = host._findNextPendingToolCall();
    if (!next) return { kind: "drained" };

    // Mark as running in tool_call meta so the display shows shimmer.
    host._updateToolCallExecState(next.toolCallId, "running");

    const ctx: ToolPreflightContext = {
      agentName: next.agentName,
      toolName: next.toolName,
      toolArgs: next.toolArgs,
      toolCallId: next.toolCallId,
      summary: `${next.agentName} is calling ${next.toolName}`,
    };

    let denyMessage: string | undefined;
    let allowOnce = false;
    // Skip the permission gate if this tool_call was already approved
    // (allow-once grant was set in resolveApprovalAsk before resume).
    allowOnce = host._permissionAdvisor["_allowOnceGrants"].has(next.toolCallId);
    if (!allowOnce) {
      const decision = await host._beforeToolExecute(ctx);
      if (signal?.aborted) {
        host._updateToolCallExecState(next.toolCallId, "not_started");
        return { kind: "interrupted" };
      }
      if (decision && decision.kind === "ask") {
        const ask = decision.ask;
        ask.turnIndex = next.turnIndex;
        const askContextId = host._findToolCallContextId(next.toolCallId, next.roundIndex);
        host._updateToolCallExecState(next.toolCallId, "not_started");
        host._activeAsk = ask;
        host._agentState = "waiting";
        host._emitAskRequestedProgress(host._activeAsk);
        host._appendEntry(createAskRequest(
          host._nextLogId("ask_request"),
          next.turnIndex,
          host._activeAsk!.payload,
          host._activeAsk!.id,
          host._activeAsk!.kind,
          next.toolCallId,
          next.roundIndex,
          askContextId,
        ), false);
        host._pendingTurnState = { stage: "activation" };
        host.onSaveRequest?.();
        return { kind: "suspended", ask, toolCallId: next.toolCallId };
      }
      if (decision && decision.kind === "deny") {
        denyMessage = decision.message;
      }
    } else {
      // Gate already passed; still run hooks
      if (host.hookRuntime.hooks.length > 0) {
        const hookResult = await host.hookRuntime.evaluate("PreToolUse", {
          event: "PreToolUse",
          timestamp: Date.now(),
          toolName: next.toolName,
          toolArgs: next.toolArgs,
          toolCallId: next.toolCallId,
        });
        if (signal?.aborted) {
          host._updateToolCallExecState(next.toolCallId, "not_started");
          return { kind: "interrupted" };
        }
        if (hookResult.decision === "deny") {
          denyMessage = hookResult.denyReason ?? "Denied by hook";
        } else if (hookResult.updatedInput) {
          Object.assign(next.toolArgs, hookResult.updatedInput);
        }
      }
    }

    // Execute (or deny)
    const contextId = host._findToolCallContextId(next.toolCallId, next.roundIndex)
      ?? host._allocateContextId();
    const execStartMs = Date.now();
    let resultContent = "";
    let isError = false;
    let toolMetadata: Record<string, unknown> = {};

    if (denyMessage) {
      resultContent = `ERROR: ${denyMessage}`;
      isError = true;
    } else {
      const executor = host._toolExecutors[next.toolName];
      try {
        if (signal?.aborted) {
          host._updateToolCallExecState(next.toolCallId, "not_started");
          return { kind: "interrupted" };
        }
        if (!executor) {
          resultContent = `ERROR: No executor for tool '${next.toolName}'`;
          isError = true;
        } else {
          const result = await executor(next.toolArgs, { signal });
          // Keep toolExecState as "running" here —_completeMissingToolResultsFromLog
          // uses it to distinguish "ran but interrupted" (partial effects) from "never ran".
          if (signal?.aborted) return { kind: "interrupted" };
          if (typeof result === "string") {
            resultContent = result;
          } else if (result instanceof ToolResult) {
            resultContent = result.content;
            toolMetadata = { ...result.metadata };
            if (result.contentBlocks) {
              toolMetadata._contentBlocks = result.contentBlocks;
            }
          } else {
            resultContent = String(result);
          }
          isError = resultContent.startsWith("ERROR:");
        }
      } catch (e) {
        if (signal?.aborted) {
          return { kind: "interrupted" };
        }
        resultContent = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
    }

    // Build preview (matches tool-loop's logic)
    const previewSrc = toolMetadata["tui_preview"];
    let previewText: string | undefined;
    let previewDim: boolean | undefined;
    if (previewSrc && typeof previewSrc === "object") {
      const text = (previewSrc as Record<string, unknown>)["text"];
      if (typeof text === "string" && text.trim()) {
        previewText = text;
        previewDim = (previewSrc as Record<string, unknown>)["dim"] === true ? true : undefined;
      }
    }
    if (!previewText && !isError) {
      const lines = resultContent.split("\n");
      previewText = lines.length > 20
        ? lines.slice(0, 20).join("\n") + `\n... (${lines.length - 20} more lines)`
        : resultContent;
      previewDim = true;
    }

    host._appendEntry(createToolResultEntry(
      host._nextLogId("tool_result"),
      next.turnIndex,
      next.roundIndex,
      {
        toolCallId: next.toolCallId,
        toolName: next.toolName,
        content: resultContent,
        toolSummary: `${next.toolName} ${isError ? "failed" : "completed"}`,
      },
      {
        isError,
        contextId,
        toolMetadata: Object.keys(toolMetadata).length > 0 ? toolMetadata : undefined,
        execStartMs,
        previewText,
        previewDim,
      },
    ));
    host._updateToolCallExecState(next.toolCallId, isError ? "failed" : "completed");

    if (host.hookRuntime.hooks.length > 0) {
      const event = isError ? "PostToolUseFailure" : "PostToolUse";
      host.hookRuntime.fireAndForget(event, {
        event,
        timestamp: Date.now(),
        toolName: next.toolName,
        toolCallId: next.toolCallId,
        agentId: next.agentName,
      });
    }

    host.onSaveRequest?.();
  }
}

/**
 * Find the next pending tool_call in the active window (no matching result),
 * in log/emission order. Returns null when all are resolved.
 * Window-wide rather than per-turn: an approved tool_call must execute on
 * resume even if the turn counter advanced while the ask was pending.
 */
export function findNextPendingToolCall(host: ToolDrainHost): {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  turnIndex: number;
  roundIndex: number;
  agentName: string;
} | null {
  const found = host._firstPendingToolCall();
  if (!found) return null;
  const entry = found.entry;
  const meta = entry.meta as Record<string, unknown>;
  const content = entry.content as { name?: string; arguments?: Record<string, unknown> };
  return {
    toolCallId: String(meta["toolCallId"] ?? ""),
    toolName: String(content.name ?? meta["toolName"] ?? ""),
    toolArgs: content.arguments ?? {},
    turnIndex: entry.turnIndex,
    roundIndex: entry.roundIndex ?? 0,
    agentName: String(meta["agentName"] ?? host.primaryAgent.name),
  };
}

/** Update tool_call entry's toolExecState meta in-place. */
export function updateToolCallExecState(host: ToolDrainHost, 
  toolCallId: string,
  state: "not_started" | "running" | "completed" | "failed",
): void {
  const entry = host._logStore.findToolCallByCallId(toolCallId);
  if (!entry) return;
  (entry.meta as Record<string, unknown>)["toolExecState"] = state;
  host._touchLog();
}

/** Returns true if the path is strictly inside the session artifacts dir. */
export function isInsideArtifactsDir(host: ToolDrainHost, rawPath: unknown): boolean {
  if (typeof rawPath !== "string" || !rawPath) return false;
  const artifactsDir = host._getArtifactsDirIfAvailable();
  if (!artifactsDir) return false;
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(host._projectRoot, rawPath);
  const rel = relative(artifactsDir, absPath);
  if (!rel) return false; // exact match means writing the artifacts dir itself
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export async function beforeToolExecute(
  host: ToolDrainHost,
  ctx: ToolPreflightContext,
): Promise<ToolPreflightDecision | void> {
  // 0a. Artifacts-dir bypass: file tools (read/write/edit/list/glob/grep)
  //    operating inside session artifacts/ don't need approval (agent-owned
  //    scratch space). Bash is excluded —its cwd-tracking is a separate gate.
  const ARTIFACTS_BYPASS_TOOLS = new Set([
    "read_file", "write_file", "edit_file", "list_dir", "glob", "grep",
  ]);
  const skipPermissionGate =
    ARTIFACTS_BYPASS_TOOLS.has(ctx.toolName) &&
    host._isInsideArtifactsDir((ctx.toolArgs as Record<string, unknown>)["path"]);

  // 1. Permission gate check (skip for artifacts-dir file ops)
  if (!skipPermissionGate) {
    const decision = await host.toolGate.evaluate(ctx);
    switch (decision.kind) {
      case "deny":
        return { kind: "deny", message: decision.message };
      case "ask": {
        const options = decision.offers.map((o) => o.label);
        options.push("Deny");

        const BROAD_RULE_COMMANDS = new Set(["cp", "mv", "rm", "chmod", "chown"]);
        const hasPersistent = decision.offers.some(o => o.type === "tool_pattern");
        const pattern = decision.assessment.canonicalPattern ?? "";
        const persistentWarning = hasPersistent && BROAD_RULE_COMMANDS.has(pattern)
          ? `Persistent rules below will apply to ALL "${pattern}" commands, which may cause DANGER.`
          : undefined;

        const ask: ApprovalRequest = {
          id: `approval-${randomUUID().slice(0, 8)}`,
          kind: "approval",
          createdAt: new Date().toISOString(),
          source: { agentId: ctx.agentName },
          summary: decision.question,
          roundIndex: undefined,
          payload: {
            toolCallId: ctx.toolCallId,
            toolName: ctx.toolName,
            toolSummary: ctx.summary,
            permissionClass: decision.assessment.permissionClass,
            offers: decision.offers.map((o) => ({
              type: o.type,
              label: o.label,
              scope: o.scope,
              rule: o.rule as Record<string, unknown> | undefined,
            })),
            persistentWarning,
          },
          options,
        };
        return { kind: "ask", ask };
      }
    }
  }

  // 2. PreToolUse hooks (run after permission gate allows)
  if (host.hookRuntime.hooks.length > 0) {
    const hookPayload: HookPayload = {
      event: "PreToolUse",
      timestamp: Date.now(),
      toolName: ctx.toolName,
      toolArgs: ctx.toolArgs,
      toolCallId: ctx.toolCallId,
    };
    const hookResult = await host.hookRuntime.evaluate("PreToolUse", hookPayload);
    if (hookResult.decision === "deny") {
      return { kind: "deny", message: hookResult.denyReason ?? "Denied by hook" };
    }
    // Apply updatedInput from hooks (merge into tool args)
    if (hookResult.updatedInput) {
      Object.assign(ctx.toolArgs, hookResult.updatedInput);
    }
  }

  return undefined;
}
