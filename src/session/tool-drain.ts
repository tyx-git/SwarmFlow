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
  onSaveRequest?: () => boolean;
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
 * 按产生顺序排空当前轮次里待执行的 tool_call。每个调用依次
 * 过闸门 →执行 →追加 tool_result，并更新 tool_call 的 meta。
 * 返回结构化结果，避免审批挂起和中断被压成同一条空字符串续跑路径。
 *
 * 这是流式 tool-loop 之外执行 tool_call 的唯一规范路径——
 * 审批 resume 之后以及处理孤立的并行 tool_call 时都走它。
 */
export async function drainPendingToolCalls(host: ToolDrainHost, signal?: AbortSignal): Promise<DrainPendingToolCallsResult> {
  while (true) {
    if (signal?.aborted) return { kind: "interrupted" };

    const next = host._findNextPendingToolCall();
    if (!next) return { kind: "drained" };

    // 在 tool_call meta 里标记为 running，让界面显示流动效果。
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
    // 该 tool_call 已获批时跳过权限闸门
    //（resume 之前 resolveApprovalAsk 已写入 allow-once 授权）。
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
      // 闸门已通过，但仍要跑钩子
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

    // 执行（或拒绝）
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
          // 这里保持 toolExecState 为 "running"——_completeMissingToolResultsFromLog
          // 靠它区分“跑了但被中断”（可能有部分副作用）和“从未执行”。
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

    // 构造预览（与 tool-loop 的逻辑一致）
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
 * 在活跃窗口内按日志（产生）顺序找下一个待执行的 tool_call（还没有对应结果）。
 * 全部有结果时返回 null。
 * 按窗口而非按轮次查找：已批准的 tool_call 必须在 resume 时执行，
 * 即使 ask 挂起期间轮次计数已经推进。
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

/** 就地更新 tool_call 条目的 toolExecState meta。 */
export function updateToolCallExecState(host: ToolDrainHost, 
  toolCallId: string,
  state: "not_started" | "running" | "completed" | "failed",
): void {
  const entry = host._logStore.findToolCallByCallId(toolCallId);
  if (!entry) return;
  (entry.meta as Record<string, unknown>)["toolExecState"] = state;
  host._touchLog();
}

/** 路径严格位于会话 artifacts 目录内时返回 true。 */
export function isInsideArtifactsDir(host: ToolDrainHost, rawPath: unknown): boolean {
  if (typeof rawPath !== "string" || !rawPath) return false;
  const artifactsDir = host._getArtifactsDirIfAvailable();
  if (!artifactsDir) return false;
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(host._projectRoot, rawPath);
  const rel = relative(artifactsDir, absPath);
  if (!rel) return false; // 完全相等说明要写的就是 artifacts 目录本身
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export async function beforeToolExecute(
  host: ToolDrainHost,
  ctx: ToolPreflightContext,
): Promise<ToolPreflightDecision | void> {
  // 0a. artifacts 目录放行：文件类工具（read/write/edit/list/glob/grep）
  //    在会话 artifacts/ 内操作无需审批（这是 agent 自己的草稿区）。
  //    Bash 除外——它的 cwd 跟踪是另一套闸门。
  const ARTIFACTS_BYPASS_TOOLS = new Set([
    "read_file", "write_file", "edit_file", "list_dir", "glob", "grep",
  ]);
  const skipPermissionGate =
    ARTIFACTS_BYPASS_TOOLS.has(ctx.toolName) &&
    host._isInsideArtifactsDir((ctx.toolArgs as Record<string, unknown>)["path"]);

  // 1. 权限闸门检查（artifacts 目录内的文件操作跳过）
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

  // 2. PreToolUse 钩子（权限闸门放行后执行）
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
    // 应用钩子返回的 updatedInput（合并进工具参数）
    if (hookResult.updatedInput) {
      Object.assign(ctx.toolArgs, hookResult.updatedInput);
    }
  }

  return undefined;
}
