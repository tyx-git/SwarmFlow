/** 子会话句柄、恢复载荷、spawn 选项与管理器依赖。 */

import type { Agent } from "../../agents/agent.js";

import type { HookEvent, HookPayload } from "../../hooks/index.js";

import type { LogEntry } from "../../context/entry/types.js";

import { type LoadLogResult } from "../../config/log-serialization.js";

import type { ProgressReporter } from "../../logging/progress.js";

import type { Session } from "../../session.js";

import {
  type ChildSessionLifecycle,
  type ChildSessionMetaRecord,
  type ChildSessionMode,
  type ChildSessionOutcome,
  type ChildSessionPhase,
  type ChildSessionSnapshot,
  type ChildTaskHandoff,
  type MessageEnvelope,
} from "../tree-types.js";

import { type PersistedRoleModelSelection } from "../role-model-resolver.js";

export interface ChildSessionHandle {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  status: "working" | "idle" | "error" | "interrupted" | "terminated" | "completed";
  phase: ChildSessionPhase;
  /**
   * settled one-shot 子会话后为 null：其日志在磁盘（按需读回），
   * frozenSnapshot 服务于 Agents 面板。persistent 子会话保留 Session 以便复活。
   */
  session: Session | null;
  /** release 时捕获的最终快照（见 _freezeAndRelease）。 */
  frozenSnapshot?: ChildSessionSnapshot | null;
  sessionDir: string;
  artifactsDir: string;
  resultText: string;
  elapsed: number;
  startTime: number;
  turnPromise: Promise<string> | null;
  abortController: AbortController | null;
  recentEvents: string[];
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  lastTotalTokens: number;
  lastOutcome: ChildSessionOutcome;
  lastActivityAt: number;
  order: number;
  /** suspendAll / archiveAll 设置，防止僵尸 finishChildTurn 回调。 */
  suspended: boolean;
  /** settlePromise：finishChildTurn 完成时 resolve。在 _startChildTurn 创建，finishChildTurn 中 resolve。 */
  settlePromise: Promise<void> | null;
  settleResolve: (() => void) | null;
  terminationCause?: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
}

export interface PreparedChildRestore {
  record: ChildSessionMetaRecord;
  agent: Agent;
  sessionDir: string;
  artifactsDir: string;
  loaded: LoadLogResult;
}

/** Session 暴露给子会话实例化的构造函数表面。 */
export interface ChildSessionSpawnOpts {
  primaryAgent: Agent;
  artifactsDir: string;
  /** 项目内 shell 日志目录：`.swarmflow/<root-session-id>/agents/<child-id>/shells`。 */
  shellLogDir: string;
  promptCacheKey: string;
  onTurnOutput: (text: string) => void;
  onSaveRequest: () => void;
}

export interface ChildSessionManagerDeps {
  // 父日志 & 记账
  appendEntry(entry: LogEntry, notify?: boolean): void;
  nextLogId(type: LogEntry["type"]): string;
  allocateContextId(): string;
  getTurnCount(): number;
  notifyLogListeners(): void;
  requestSave(): void;
  /** 标准传递到父 inbox（root._deliverMessage）。 */
  deliverMessageToParent(msg: MessageEnvelope): void;
  // 子会话私有访问（闭包在 Session 内部——同类私有访问）
  deliverToChild(child: Session, msg: MessageEnvelope): void;
  childHasInbox(child: Session): boolean;
  setChildInbox(child: Session, msgs: MessageEnvelope[]): void;
  recordChildEvent(child: Session, event: string): void;
  normalizeChildInterruptedTurn(child: Session, message: string): void;
  /**
   * 子会话 settle 时（`_freezeAndRelease` 之前）回传只读摘要，
   * 供父会话把"子拆分结果"写进对应任务的 metadata。
   */
  reportChildSettled?(info: {
    childId: string;
    outcome: ChildSessionOutcome;
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
    taskSummary: { total: number; open: number; done: number } | undefined;
    openTasks: ChildTaskHandoff[];
  }): void;
  /** 持久化子会话日志+meta。路由经 Session._saveChildSession。返回保存是否成功——决定释放逻辑。 */
  saveChildSession(handle: ChildSessionHandle): boolean;
  // 父环境
  getProgress(): ProgressReporter | undefined;
  fireHook(event: HookEvent, payload: HookPayload): void;
  resolveSessionArtifacts(): string;
  getArtifactsDir(): string;
  /** 子会话的 shell 日志目录（项目内 .swarmflow/<root-id>/agents/<child-id>/shells）。 */
  resolveChildShellLogDir(childId: string): string;
  /** 根会话的 prompt cache 亲和键；子会话 key = 根 key + child id。 */
  getPromptCacheKey(): string;
  getPreferredThinkingLevel(): string;
  getPrimaryAgent(): Agent;
  getAgentTemplates(): Record<string, Agent>;
  // 子代理工厂
  createFromPredefined(templateName: string, taskId: string, persistedSelection?: PersistedRoleModelSelection): { agent: Agent; thinkingLevel?: string };
  createFromPath(templateDir: string, taskId: string, persistedSelection?: PersistedRoleModelSelection): { agent: Agent; thinkingLevel?: string };
  resolveTemplatePath(relPath: string): string;
  buildSubAgentSystemPrompt(basePrompt: string, persistent: boolean): string;
  /** 构造子 Session（打破 Session-Manager 导入循环）。 */
  createChildSession(opts: ChildSessionSpawnOpts): Session;
}
