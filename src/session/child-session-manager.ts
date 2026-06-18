/**
 * ChildSessionManager 鈥?owns the session tree (P2.4b).
 *
 * Holds the three tables (live handles, archived records, numeric id counter)
 * plus the full child lifecycle: spawn/instantiate, turn start/finish,
 * send/revive, kill/suspend/archive, settle waiting, snapshots/status
 * reports, and the staged child restore. Parent-session services (log
 * appends, message delivery, hooks, progress, the sub-agent factory) reach
 * back into Session through the deps closures. Child Session construction is
 * injected via `createChildSession`, so this module never imports the
 * Session class at runtime (`import type` only 鈥?breaks the import cycle).
 *
 * Closures that touch a child session's private members (inbox, delivery,
 * event recording, log normalization) are defined inside Session, where
 * same-class private access is legal.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Agent } from "../agents/agent.js";
import type { PendingAskUi } from "../ask.js";
import type { HookEvent, HookPayload } from "../hooks/index.js";
import { createAgentResult, type LogEntry } from "../context/log-entry.js";
import { describeModel } from "../models/presentation.js";
import { loadLog, validateAndRepairLog, type LoadLogResult } from "../config/persistence.js";
import type { ProgressLevel, ProgressReporter } from "../lib/progress.js";
import { ToolResult } from "../providers/base.js";
import type { Session } from "../session.js";
import {
  migrateMessageEnvelope,
  type ArchivedChildRecord,
  type ChildSessionLifecycle,
  type ChildSessionMetaRecord,
  type ChildSessionMode,
  type ChildSessionOutcome,
  type ChildSessionPhase,
  type ChildSessionSnapshot,
  type MessageEnvelope,
} from "../session-tree-types.js";
import { SEND_TOOL } from "../tools/comm.js";

const SUB_AGENT_OUTPUT_LIMIT = 12_000;

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Latest non-discarded assistant text (or no_reply) in a child log. */
export function extractLatestAssistantText(entries: readonly LogEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type === "assistant_text" || entry.type === "no_reply") {
      return String(entry.content ?? entry.display ?? "");
    }
  }
  return "";
}

// ------------------------------------------------------------------
// ChildSessionHandle 鈥?tracked nested child session state
// ------------------------------------------------------------------

export interface ChildSessionHandle {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  status: "working" | "idle" | "error" | "interrupted" | "terminated" | "completed";
  phase: ChildSessionPhase;
  /**
   * Null after a settled one-shot child is released: its log lives on disk
   * (read back on demand for the child tab) and `frozenSnapshot` serves the
   * Agents panel. Persistent children keep their Session for revival.
   */
  session: Session | null;
  /** Final snapshot captured at release time (see _freezeAndRelease). */
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
  /** Set by suspendAll / archiveAll to prevent zombie finishChildTurn callbacks. */
  suspended: boolean;
  /** Resolve when finishChildTurn completes. Created in _startChildTurn, resolved in finishChildTurn. */
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

/** Constructor surface Session exposes for child instantiation. */
export interface ChildSessionSpawnOpts {
  primaryAgent: Agent;
  artifactsDir: string;
  promptCacheKey: string;
  onTurnOutput: (text: string) => void;
  onSaveRequest: () => void;
}

export interface ChildSessionManagerDeps {
  // Parent log & bookkeeping
  appendEntry(entry: LogEntry, notify?: boolean): void;
  nextLogId(type: LogEntry["type"]): string;
  allocateContextId(): string;
  getTurnCount(): number;
  notifyLogListeners(): void;
  requestSave(): void;
  /** Standard delivery into the PARENT's inbox (root._deliverMessage). */
  deliverMessageToParent(msg: MessageEnvelope): void;
  // Child-session private access (closures live inside Session 鈥?same-class
  // private access; keeps instance-level test mocks effective)
  deliverToChild(child: Session, msg: MessageEnvelope): void;
  childHasInbox(child: Session): boolean;
  setChildInbox(child: Session, msgs: MessageEnvelope[]): void;
  recordChildEvent(child: Session, event: string): void;
  normalizeChildInterruptedTurn(child: Session, message: string): void;
  /** Persist a child's log+meta. Routed via Session._saveChildSession so tests
   * can stub it. Returns whether the save succeeded 鈥?release decisions hinge
   * on it (never drop an in-memory log whose disk copy is stale). */
  saveChildSession(handle: ChildSessionHandle): boolean;
  // Parent environment
  getProgress(): ProgressReporter | undefined;
  fireHook(event: HookEvent, payload: HookPayload): void;
  resolveSessionArtifacts(): string;
  getArtifactsDir(): string;
  getPreferredThinkingLevel(): string;
  getPrimaryAgent(): Agent;
  getAgentTemplates(): Record<string, Agent>;
  // Sub-agent factory (SubAgentFactory via Session delegates)
  createFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string };
  createFromPath(templateDir: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string };
  resolveTemplatePath(relPath: string): string;
  buildSubAgentSystemPrompt(basePrompt: string, persistent: boolean): string;
  /** Construct the child Session (breaks the Session鈫攎anager import cycle). */
  createChildSession(opts: ChildSessionSpawnOpts): Session;
}

export class ChildSessionManager {
  private _handles = new Map<string, ChildSessionHandle>();
  private _archived = new Map<string, ArchivedChildRecord>();
  private _counter = 0;

  constructor(private readonly deps: ChildSessionManagerDeps) {}

  get handles(): Map<string, ChildSessionHandle> {
    return this._handles;
  }

  get archived(): Map<string, ArchivedChildRecord> {
    return this._archived;
  }

  get counter(): number {
    return this._counter;
  }

  set counter(value: number) {
    this._counter = value;
  }

  /** Drop both tables (fresh-session reset; counter is reset separately). */
  clearTables(): void {
    this._handles = new Map();
    this._archived = new Map();
    // Child ids (worker-1, explorer鈥? recur across sessions 鈥?a cache entry
    // surviving /new or /resume would serve the previous session's log.
    this._releasedLogCache = null;
  }

  // ==================================================================
  // Snapshots & status reports
  // ==================================================================

  getSnapshots(): ChildSessionSnapshot[] {
    return [...this._handles.values()]
      .map((handle) => this._buildSnapshot(handle))
      .sort((a, b) => {
        const rank = (snapshot: ChildSessionSnapshot): number => {
          if (snapshot.lifecycle === "running") return 0;
          if (snapshot.lifecycle === "blocked") return 1;
          if (snapshot.lifecycle === "idle") return 2;
          if (snapshot.lifecycle === "archived") return 3;
          return 3;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        return a.numericId - b.numericId;
      });
  }

  getChildLog(childId: string): readonly LogEntry[] | null {
    const handle = this._handles.get(childId);
    if (!handle) return null;
    if (handle.session) return handle.session.log;
    return this._loadReleasedChildLog(handle);
  }

  /**
   * Single-slot cache for released children's logs: at most one released
   * child's log is resident (the tab being viewed), with a stable array
   * identity so the TUI projection memo holds across polls. Keyed by
   * sessionDir 鈥?unique per child per root session, unlike child ids.
   */
  private _releasedLogCache: { sessionDir: string; entries: LogEntry[] } | null = null;

  private _loadReleasedChildLog(handle: ChildSessionHandle): readonly LogEntry[] {
    if (this._releasedLogCache?.sessionDir === handle.sessionDir) {
      return this._releasedLogCache.entries;
    }
    try {
      const loaded = loadLog(handle.sessionDir);
      const repaired = validateAndRepairLog(loaded.entries);
      this._releasedLogCache = { sessionDir: handle.sessionDir, entries: repaired.entries };
      return repaired.entries;
    } catch {
      // Missing/corrupt child log on disk 鈥?show an empty transcript rather
      // than crashing the tab.
      return [];
    }
  }

  /**
   * A settled one-shot child can never run again: sends are mode-guarded,
   * revival is persistent-only, and its result already lives in the parent
   * log. Its Session existed only so the TUI could read the log and the
   * Agents panel its metadata 鈥?freeze the final snapshot, drop the Session
   * (and with it the in-memory log), and serve the log from disk on demand.
   * The log was persisted by saveChildSession just before this runs.
   */
  private _freezeAndRelease(handle: ChildSessionHandle, persistedOk: boolean): void {
    if (!handle.session) return;
    if (handle.mode !== "oneshot" || handle.lifecycle !== "archived") return;
    // The disk copy is the only copy after release 鈥?never drop the
    // in-memory log when the settle-time save failed (the on-disk log
    // would be the stale spawn-time one).
    if (!persistedOk) return;
    handle.frozenSnapshot = this._buildSnapshot(handle);
    handle.session = null;
    handle.turnPromise = null;
    handle.abortController = null;
  }

  private _isLive(handle: ChildSessionHandle): boolean {
    return handle.lifecycle === "running" || handle.lifecycle === "blocked";
  }

  private _buildSnapshot(handle: ChildSessionHandle): ChildSessionSnapshot {
    const session = handle.session;
    if (!session) {
      // Released child 鈥?the frozen snapshot is the source of truth.
      if (handle.frozenSnapshot) return handle.frozenSnapshot;
      // Defensive: released without a frozen snapshot (shouldn't happen).
      return {
        id: handle.id,
        numericId: handle.numericId,
        logRevision: 0,
        template: handle.template,
        mode: handle.mode,
        lifecycle: handle.lifecycle,
        phase: "idle",
        outcome: handle.lastOutcome,
        running: false,
        lifetimeToolCallCount: handle.lifetimeToolCallCount,
        lastTotalTokens: handle.lastTotalTokens,
        lastToolCallSummary: handle.lastToolCallSummary,
        recentEvents: [...handle.recentEvents],
        pendingInboxCount: 0,
        lastActivityAt: handle.lastActivityAt,
        inputTokens: 0,
        contextBudget: 0,
        modelConfigName: "",
        modelProvider: "",
        modelDisplayLabel: "",
        pendingAskId: null,
        pendingAskKind: null,
        activeLogEntryId: null,
        turnElapsed: handle.elapsed,
        cacheReadTokens: 0,
      };
    }
    const currentTurnRunning = session.currentTurnRunning;
    const pendingAsk: PendingAskUi | null = session.getPendingAsk();
    const hasPendingResume = session.hasPendingTurnToResume();
    const phase = pendingAsk || hasPendingResume
      ? "waiting"
      : currentTurnRunning
        ? session.sessionPhase
        : "idle";
    const modelConfig = session.primaryAgent?.modelConfig;
    const modelDescriptor = modelConfig
      ? describeModel({
          configName: modelConfig.name,
          providerId: modelConfig.provider,
          selectionKey: modelConfig.model,
          modelId: modelConfig.model,
        })
      : null;
    const sessionLastTurnEndStatus = session.lastTurnEndStatus;
    const outcome =
      handle.lastOutcome !== "none"
        ? handle.lastOutcome
        : sessionLastTurnEndStatus === "completed"
          ? "completed"
          : sessionLastTurnEndStatus === "interrupted"
            ? "interrupted"
            : sessionLastTurnEndStatus === "error"
              ? "error"
              : "none";
    return {
      id: handle.id,
      numericId: handle.numericId,
      logRevision: session.getLogRevision(),
      template: handle.template,
      mode: handle.mode,
      lifecycle: handle.lifecycle,
      phase,
      outcome,
      running: currentTurnRunning,
      lifetimeToolCallCount: session.lifetimeToolCallCount,
      lastTotalTokens: session.lastTotalTokens,
      lastToolCallSummary: session.lastToolCallSummary,
      recentEvents: [...session.recentSessionEvents],
      pendingInboxCount: session.pendingInboxCount,
      lastActivityAt: handle.lastActivityAt,
      // Child page chrome fields
      inputTokens: session.lastTotalTokens,
      contextBudget: session.contextBudget,
      modelConfigName: modelConfig?.name ?? "",
      modelProvider: modelConfig?.provider ?? "",
      modelDisplayLabel: modelDescriptor?.scopedLabel ?? modelConfig?.model ?? "",
      pendingAskId: pendingAsk?.id ?? null,
      pendingAskKind: pendingAsk?.kind ?? null,
      activeLogEntryId: session.activeLogEntryId,
      turnElapsed: handle.startTime > 0 && currentTurnRunning
        ? (performance.now() - handle.startTime) / 1000
        : handle.elapsed,
      cacheReadTokens: session.lastCacheReadTokens,
    };
  }

  buildDetailedStatusReport(): string {
    const snapshots = this.getSnapshots();
    if (snapshots.length === 0) return "No sub-sessions tracked.";
    const sections = snapshots.map((snapshot) => {
      const recent = snapshot.recentEvents.length > 0
        ? snapshot.recentEvents.map((event, index) => `  ${index + 1}. ${event}`).join("\n")
        : "  (none)";
      const latest = snapshot.lastToolCallSummary || snapshot.recentEvents[snapshot.recentEvents.length - 1] || "(none)";
      return [
        `- ${snapshot.id}`,
        `  mode: ${snapshot.mode}`,
        `  lifecycle: ${snapshot.lifecycle}`,
        `  phase: ${snapshot.phase}`,
        `  outcome: ${snapshot.outcome}`,
        `  tokens: ${formatTokenCount(snapshot.lastTotalTokens)}`,
        `  tool calls: ${snapshot.lifetimeToolCallCount}`,
        `  pending inbox: ${snapshot.pendingInboxCount}`,
        `  latest: ${latest}`,
        `  recent:`,
        recent,
      ].join("\n");
    });
    return sections.join("\n\n");
  }

  // ==================================================================
  // Ask routing helpers (ask domain itself stays in Session)
  // ==================================================================

  findChildWithPendingAsk(askId: string): ChildSessionHandle | null {
    for (const handle of this._handles.values()) {
      const ask = handle.session?.getPendingAsk();
      if (ask?.id === askId) return handle;
    }
    return null;
  }

  resumeChildPendingTurn(handle: ChildSessionHandle): void {
    if (handle.turnPromise) return;
    const session = handle.session;
    if (!session?.hasPendingTurnToResume()) return;

    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "waiting";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    const abortController = new AbortController();
    handle.abortController = abortController;
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = session.resumePendingTurn({ signal: abortController.signal });
    void handle.turnPromise.then(
      () => this.finishChildTurn(handle, undefined),
      (error: unknown) => this.finishChildTurn(handle, error),
    );
  }

  // ==================================================================
  // Lifecycle
  // ==================================================================

  childSessionDir(childId: string): string {
    return join(this.deps.resolveSessionArtifacts(), "agents", childId, "session");
  }

  instantiateChild(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
    opts?: { numericId?: number; order?: number },
  ): ChildSessionHandle {
    const numericId = opts?.numericId ?? (this._counter + 1);
    this._counter = Math.max(this._counter, numericId);
    const sessionDir = this.childSessionDir(taskId);
    const artifactsDir = join(sessionDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const fullSystemPrompt = this.deps.buildSubAgentSystemPrompt(
      agent.systemPrompt,
      mode === "persistent",
    );
    agent.systemPrompt = fullSystemPrompt;

    const handle: ChildSessionHandle = {
      id: taskId,
      numericId,
      template: templateLabel,
      mode,
      lifecycle: "idle",
      status: "idle",
      phase: "idle",
      session: null,
      sessionDir,
      artifactsDir,
      resultText: "",
      elapsed: 0,
      startTime: 0,
      turnPromise: null,
      abortController: null,
      recentEvents: [],
      lifetimeToolCallCount: 0,
      lastToolCallSummary: "",
      lastTotalTokens: 0,
      lastOutcome: "none",
      lastActivityAt: Date.now(),
      order: opts?.order ?? numericId,
      suspended: false,
      settlePromise: null,
      settleResolve: null,
    };

    const childSession = this.deps.createChildSession({
      primaryAgent: agent,
      artifactsDir,
      promptCacheKey: taskId,
      onTurnOutput: (text: string) => this._handleChildTurnOutput(taskId, text),
      onSaveRequest: () => this.deps.saveChildSession(handle),
    });
    handle.session = childSession;
    return handle;
  }

  createChild(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
  ): ChildSessionHandle {
    const handle = this.instantiateChild(taskId, templateLabel, mode, agent);
    this.deps.saveChildSession(handle);
    // Fire SubagentStart hook
    this.deps.fireHook("SubagentStart", {
      event: "SubagentStart",
      timestamp: Date.now(),
      agentId: taskId,
    });
    return handle;
  }

  private _handleChildTurnOutput(childId: string, text: string): void {
    const handle = this._handles.get(childId);
    if (!handle) return;
    handle.resultText = text;
    handle.lastActivityAt = Date.now();
  }

  private _startChildTurn(handle: ChildSessionHandle, input: string, options?: { skipUserInput?: boolean }): void {
    const session = handle.session;
    if (!session) return; // released one-shot 鈥?unreachable via the mode guards
    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "thinking";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    const abortController = new AbortController();
    handle.abortController = abortController;
    // Create settle promise so close() can wait for this turn to finish
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = session.turn(input, { signal: abortController.signal, skipUserInput: options?.skipUserInput });
    void handle.turnPromise.then(
      () => this.finishChildTurn(handle, undefined),
      (error: unknown) => this.finishChildTurn(handle, error),
    );
  }

  finishChildTurn(handle: ChildSessionHandle, error?: unknown): void {
    // Zombie callback guard: if close/suspend already handled this handle, bail out.
    if (handle.suspended) {
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    // A released handle has no running turn 鈥?this callback can only be a
    // zombie from a path that also violated the release invariant. Bail.
    const session = handle.session;
    if (!session) {
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.elapsed = handle.startTime > 0 ? (performance.now() - handle.startTime) / 1000 : 0;

    const pendingAsk = !error ? session.getPendingAsk() : null;
    const hasPendingResume = !error ? session.hasPendingTurnToResume() : false;
    if (!error && (pendingAsk || hasPendingResume)) {
      handle.abortController = null;
      handle.turnPromise = null;
      handle.lifecycle = "blocked";
      handle.status = "idle";
      handle.phase = "waiting";
      handle.lastOutcome = "none";
      handle.lastActivityAt = Date.now();
      this.deps.saveChildSession(handle);
      this.deps.notifyLogListeners();
      this.deps.requestSave();
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.abortController = null;
    handle.turnPromise = null;
    handle.lastActivityAt = Date.now();

    // Fire SubagentStop hook
    this.deps.fireHook("SubagentStop", {
      event: "SubagentStop",
      timestamp: Date.now(),
      agentId: handle.id,
    });

    // Determine outcome from error / endStatus
    const endStatus = error ? "error" : session.lastTurnEndStatus;
    if (error || endStatus === "error") {
      handle.lastOutcome = "error";
      handle.status = "error";
    } else if (endStatus === "interrupted") {
      handle.lastOutcome = "interrupted";
      handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    } else {
      handle.lastOutcome = "completed";
      handle.status = handle.mode === "oneshot" ? "completed" : "idle";
    }

    const outcome: "completed" | "failed" | "interrupted" =
      handle.lastOutcome === "error"
        ? "failed"
        : handle.lastOutcome === "interrupted"
          ? "interrupted"
          : "completed";
    const cause = handle.terminationCause ?? "natural";
    const agentResult = this._buildAgentResultApiContent(handle, outcome, cause);
    this.deps.appendEntry(createAgentResult(
      this.deps.nextLogId("agent_result"),
      this.deps.getTurnCount(),
      handle.id,
      handle.numericId,
      handle.template,
      outcome,
      cause,
      Math.round((handle.elapsed ?? 0) * 1000),
      agentResult.content,
      this.deps.allocateContextId(),
      agentResult.fullOutputPath,
    ), false);
    // User-initiated kills deliver as ride-along: the user is present and
    // steering, so the parent must not wake and start reacting on its own.
    // Natural completions/failures keep waking the idle parent (safety net
    // for missing await_event).
    const userInitiatedKill = cause === "user_targeted_kill" || cause === "user_mass_interrupt";
    this.deps.deliverMessageToParent({
      type: "peer_message",
      sender: handle.id,
      content: agentResult.content,
      timestamp: Date.now(),
      wake: !userInitiatedKill,
    });
    handle.terminationCause = undefined;

    // Lifecycle transition: oneshot 鈫?archived, persistent 鈫?idle
    // NOTE: archived children stay in the live handles table during runtime
    // (snapshot + disk-served log readable for TUI). Only move to the
    // archived-records table on close/reset.
    let savedOk = false;
    if (handle.mode === "oneshot") {
      handle.lifecycle = "archived";
      savedOk = this.deps.saveChildSession(handle);
    } else {
      handle.lifecycle = "idle";
      this.deps.saveChildSession(handle);
      // Persistent: only auto-resume queued work after a natural completion.
      // User/parent-triggered kills must leave the agent idle.
      if (cause === "natural") {
        if (this.deps.childHasInbox(session)) {
          // Resolve settle before starting next turn (current turn is done)
          const resolve = handle.settleResolve;
          handle.settleResolve = null;
          resolve?.();
          this._startChildTurn(handle, "", { skipUserInput: true });
          return;
        }
      }
    }

    // Resolve settle promise
    const resolve = handle.settleResolve;
    handle.settleResolve = null;
    resolve?.();

    // One-shot children are terminal here 鈥?release the Session (the log
    // was just persisted by saveChildSession above).
    this._freezeAndRelease(handle, savedOk);
  }

  private _buildAgentResultApiContent(
    handle: ChildSessionHandle,
    outcome: "completed" | "failed" | "interrupted",
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  ): { content: string; fullOutputPath?: string } {
    const causeNote = (cause === "user_mass_interrupt" || cause === "user_targeted_kill")
      ? " by the user"
      : "";
    const header = `[Agent "${handle.id}" ${outcome}${causeNote}]`;
    const text = (handle.resultText ?? "").trim();

    if (!text) {
      return { content: `${header}\n(no output)` };
    }

    if (text.length > SUB_AGENT_OUTPUT_LIMIT) {
      const outputDir = join(this.deps.getArtifactsDir(), "agent-outputs");
      mkdirSync(outputDir, { recursive: true });
      const relativePath = `artifacts/agent-outputs/${handle.id}.md`;
      const outputPath = join(outputDir, `${handle.id}.md`);
      writeFileSync(outputPath, text);
      const truncated = text.slice(0, SUB_AGENT_OUTPUT_LIMIT);
      const truncatedAtLine = truncated.split("\n").length;
      return {
        content:
          `${header}\n` +
          `(Output truncated at ${SUB_AGENT_OUTPUT_LIMIT.toLocaleString()} chars ` +
          `(line ${truncatedAtLine}). Full output: ${relativePath}. ` +
          `Continue reading from line ${truncatedAtLine} with \`read_file(start_line=${truncatedAtLine})\`; ` +
          `do not reread the portion already received.)\n\n` +
          truncated,
        fullOutputPath: relativePath,
      };
    }

    return { content: `${header}\n${text}` };
  }

  /** Move a handle from the live table to the archived table, releasing the Session instance. */
  private _archiveHandle(handle: ChildSessionHandle): void {
    this._archived.set(handle.id, {
      id: handle.id,
      numericId: handle.numericId,
      template: handle.template,
      mode: handle.mode,
      outcome: handle.lastOutcome,
      order: handle.order,
      sessionDir: handle.sessionDir,
      artifactsDir: handle.artifactsDir,
    });
    this._handles.delete(handle.id);
  }

  sendMessageToChild(childId: string, msg: MessageEnvelope): ToolResult {
    const handle = this._handles.get(childId);
    if (!handle) {
      return new ToolResult({ content: `Agent '${childId}' not found.` });
    }
    if (handle.mode !== "persistent") {
      return new ToolResult({ content: `Agent '${childId}' is one-shot and cannot receive messages.` });
    }
    // Persistent children keep their Session for the lifetime of the root 鈥?    // a null here means the release invariant broke; fail soft.
    const session = handle.session;
    if (!session) {
      return new ToolResult({ content: `Agent '${childId}' is no longer active.` });
    }
    if (handle.lifecycle === "archived") {
      // Persistent archived child still in the live table 鈥?revive in-place.
      if (handle.mode === "persistent") {
        handle.lastActivityAt = Date.now();
        // Standard delivery (never a raw inbox push): it populates the
        // bookkeeping fields the child's drain invariant requires. wake:false
        // because we start the turn explicitly right after.
        this.deps.deliverToChild(session, { ...msg, wake: false });
        this._startChildTurn(handle, "", { skipUserInput: true });
        return new ToolResult({ content: `Agent '${childId}' revived and message sent.` });
      }
      return new ToolResult({ content: `Agent '${childId}' is a one-shot agent and cannot receive messages.` });
    }

    handle.lastActivityAt = Date.now();
    if (handle.lifecycle === "blocked") {
      return new ToolResult({
        content:
          `ERROR: Agent '${childId}' is waiting for user approval and cannot receive new messages. ` +
          "Resolve the pending approval first.",
      });
    }
    if (handle.lifecycle === "running") {
      this.deps.deliverToChild(session, msg);
      return new ToolResult({ content: `Message sent to '${childId}'.` });
    }

    // idle 鈥?queue message and start turn. Standard delivery populates the
    // bookkeeping fields the drain invariant requires; wake:false because we
    // start the turn explicitly right after.
    this.deps.deliverToChild(session, { ...msg, wake: false });
    this._startChildTurn(handle, "", { skipUserInput: true });
    return new ToolResult({ content: `Message sent to '${childId}'.` });
  }

  private _interruptBlockedChild(handle: ChildSessionHandle, message: string): void {
    const session = handle.session;
    if (!session) return; // released children have no pending turn to normalize
    this.deps.normalizeChildInterruptedTurn(session, message);
    session.requestTurnInterrupt();
    handle.lifecycle = handle.mode === "oneshot" ? "archived" : "idle";
    handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    handle.phase = "idle";
    handle.lastOutcome = "interrupted";
    handle.lastActivityAt = Date.now();
    const savedOk = this.deps.saveChildSession(handle);
    // Blocked one-shots never reach finishChildTurn 鈥?release here so the
    // "archived one-shot 鈬?released" invariant has no standing exception.
    this._freezeAndRelease(handle, savedOk);
  }

  interruptChild(childId: string): { accepted: boolean; reason?: string } {
    const handle = this._handles.get(childId);
    if (!handle) return { accepted: false, reason: "not_found" };
    if (!this._isLive(handle)) return { accepted: false, reason: "not_live" };
    handle.terminationCause = "user_targeted_kill";
    if (handle.abortController) {
      handle.abortController.abort();
    } else {
      this._interruptBlockedChild(handle, "Sub-agent was interrupted while waiting for user approval.");
      this.deps.notifyLogListeners();
      this.deps.requestSave();
    }
    return { accepted: true };
  }

  hasActiveAgents(): boolean {
    return this._getWorkingHandles().length > 0;
  }

  private _getWorkingHandles(): ChildSessionHandle[] {
    return [...this._handles.values()].filter((handle) => {
      return handle.lifecycle === "running" && handle.turnPromise !== null;
    });
  }

  cascadeKillRunning(cause: "user_mass_interrupt" | "parent_kill"): number {
    let interrupted = 0;
    for (const handle of this._handles.values()) {
      if (!this._isLive(handle)) continue;
      handle.terminationCause = cause;
      // Record before the blocked-interrupt path: it may release the handle,
      // and the event must land inside the frozen snapshot.
      if (handle.session) {
        this.deps.recordChildEvent(handle.session, cause === "user_mass_interrupt" ? "interrupted by user" : "interrupted by parent");
      }
      if (handle.abortController) {
        handle.abortController.abort();
      } else {
        this._interruptBlockedChild(handle, "Sub-agent was interrupted while waiting for user approval.");
      }
      interrupted += 1;
    }
    return interrupted;
  }

  /**
   * Suspend all child sessions for close(). Preserves lifecycle semantics:
   * - running persistent 鈫?normalize + idle
   * - running oneshot 鈫?normalize + archived
   * - idle persistent 鈫?stays idle
   * Saves log + inbox for all non-archived children.
   */
  suspendAll(): void {
    const toArchive: string[] = [];
    for (const [name, handle] of this._handles) {
      handle.suspended = true;
      if (this._isLive(handle) && handle.session) {
        handle.abortController?.abort();
        // Normalize the child's log before persisting
        this.deps.normalizeChildInterruptedTurn(
          handle.session,
          "Parent session was interrupted by the user.",
        );
        handle.lastOutcome = "interrupted";
        if (handle.mode === "oneshot") {
          handle.lifecycle = "archived";
          handle.status = "interrupted";
          toArchive.push(name);
        } else {
          handle.lifecycle = "idle";
          handle.status = "idle";
        }
        handle.lastActivityAt = Date.now();
        const progress = this.deps.getProgress();
        if (progress) {
          progress.emit({
            step: this.deps.getTurnCount(),
            agent: name,
            action: "agent_suspended",
            message: `  [#${handle.numericId} ${name}] suspended (${handle.lifecycle})`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {},
            extra: { sub_agent_id: handle.numericId },
          });
        }
      }
      this.deps.saveChildSession(handle);
    }
    // Move oneshot-archived handles out of the live table after iteration
    for (const id of toArchive) {
      const handle = this._handles.get(id);
      if (handle) this._archiveHandle(handle);
    }
  }

  /**
   * Archive all child sessions unconditionally. Used by _resetTransientState() for /new.
   * All children 鈫?archived regardless of mode or current lifecycle.
   */
  archiveAll(): void {
    for (const [_name, handle] of this._handles) {
      handle.suspended = true;
      if (this._isLive(handle) && handle.session) {
        handle.abortController?.abort();
        this.deps.normalizeChildInterruptedTurn(
          handle.session,
          "Session was reset by user.",
        );
        handle.lastOutcome = handle.lastOutcome === "none" ? "interrupted" : handle.lastOutcome;
      }
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.lastActivityAt = Date.now();
      this.deps.saveChildSession(handle);
    }
    // Move all to archived map
    for (const [_name, handle] of this._handles) {
      this._archived.set(handle.id, {
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        outcome: handle.lastOutcome,
        order: handle.order,
        sessionDir: handle.sessionDir,
        artifactsDir: handle.artifactsDir,
      });
    }
    this._handles.clear();
  }

  /** Wait for all running child turns to settle, with timeout. */
  async waitForAllTurnsSettled(): Promise<void> {
    const SETTLE_TIMEOUT_MS = 3000;
    const settlePromises = [...this._handles.values()]
      .filter((h) => h.settlePromise)
      .map((h) => h.settlePromise!);
    if (settlePromises.length === 0) return;
    await Promise.race([
      Promise.all(settlePromises),
      new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
    ]);
  }

  // ==================================================================
  // spawn / kill_agent / send tool bodies (arg validation stays in Session)
  // ==================================================================

  spawnFromSpecs(tasksSpec: Array<Record<string, unknown>>): ToolResult {
    const spawned: string[] = [];
    const spawnedInfo: Array<{ numericId: number; taskId: string; template: string; task: string }> = [];
    const errors: string[] = [];

    for (const spec of tasksSpec) {
      const taskId = ((spec["id"] as string) ?? "").trim();
      const templateName = ((spec["template"] as string) ?? "").trim();
      const templatePath = ((spec["template_path"] as string) ?? "").trim();
      const taskDesc = ((spec["task"] as string) ?? "").trim();
      const modeRaw = ((spec["mode"] as string) ?? "").trim();
      const modelLevel = typeof spec["model_level"] === "string" ? spec["model_level"].trim() : undefined;

      if (!taskId || !taskDesc) {
        errors.push("Skipped entry: missing 'id' or 'task'.");
        continue;
      }
      if (!templateName && !templatePath) {
        errors.push(`'${taskId}': must specify either 'template' or 'template_path'.`);
        continue;
      }
      if (templateName && templatePath) {
        errors.push(`'${taskId}': cannot specify both 'template' and 'template_path'.`);
        continue;
      }
      if (this._handles.has(taskId)) {
        errors.push(`'${taskId}': already running.`);
        continue;
      }

      if (modeRaw !== "oneshot" && modeRaw !== "persistent") {
        errors.push(`'${taskId}': mode must be 'oneshot' or 'persistent'.`);
        continue;
      }
      const mode: ChildSessionMode = modeRaw;

      let agent: Agent;
      let tierThinkingLevel: string | undefined;
      let templateLabel: string;
      try {
        if (templateName) {
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPredefined(templateName, taskId, modelLevel));
          templateLabel = templateName;
        } else {
          const resolvedPath = this.deps.resolveTemplatePath(templatePath);
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPath(resolvedPath, taskId, modelLevel));
          templateLabel = templatePath;
        }
      } catch (e) {
        errors.push(`'${taskId}': ${e}`);
        continue;
      }

      const primaryAgent = this.deps.getPrimaryAgent();
      if (mode === "persistent" && !primaryAgent.tools.some((t) => t.name === "send")) {
        primaryAgent.tools.push(SEND_TOOL);
      }

      const handle = this.createChild(taskId, templateLabel, mode, agent);
      // Tier/pin wins; otherwise inherit parent's preferred level. Setter resolves
      // against the child's model and persists _preferredThinkingLevel into log meta.
      if (handle.session) {
        handle.session.thinkingLevel = tierThinkingLevel ?? this.deps.getPreferredThinkingLevel();
      }
      this._handles.set(taskId, handle);
      spawned.push(taskId);
      spawnedInfo.push({ numericId: handle.numericId, taskId, template: templateLabel, task: taskDesc });

      const progress = this.deps.getProgress();
      if (progress) {
        progress.onAgentStart(
          this.deps.getTurnCount(),
          taskId,
          { sub_agent_id: handle.numericId, template: templateLabel },
        );
      }

      this._startChildTurn(handle, taskDesc);
    }

    const parts: string[] = [];
    if (spawned.length) {
      parts.push(
        `Spawned ${spawned.length} sub-session(s): ${spawned.join(", ")}. ` +
        "Results will be delivered as each child session completes a turn.",
      );
    }
    if (errors.length) {
      parts.push("Errors: " + errors.join(" | "));
    }

    // Build TUI preview: list each sub-agent with truncated task
    let previewText: string | undefined;
    if (spawnedInfo.length) {
      const maxTaskLen = 60;
      const lines = spawnedInfo.map((info) => {
        const taskOneLine = info.task.replace(/\s+/g, " ");
        const taskTrunc = taskOneLine.length > maxTaskLen
          ? taskOneLine.slice(0, maxTaskLen - 1) + "鈥?
          : taskOneLine;
        return `  #${info.numericId} ${info.taskId} [${info.template}] 鈥?${taskTrunc}`;
      });
      previewText = `Spawned ${spawnedInfo.length} sub-agent(s):\n${lines.join("\n")}`;
    }

    return new ToolResult({
      content: parts.join("\n") || "No agents spawned.",
      metadata: previewText ? { tui_preview: { text: previewText, dim: true } } : undefined,
    });
  }

  killAgents(ids: string[]): ToolResult {
    const killed: string[] = [];
    const notFound: string[] = [];
    const alreadyArchived: string[] = [];

    for (const name of ids) {
      const handle = this._handles.get(name);
      if (!handle) {
        if (this._archived.has(name)) {
          alreadyArchived.push(name);
        } else {
          notFound.push(name);
        }
        continue;
      }

      handle.abortController?.abort();
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.lastOutcome = "interrupted";
      handle.lastActivityAt = Date.now();
      if (handle.session) {
        this.deps.recordChildEvent(handle.session, "terminated by parent");
      }
      // A released handle's panel state comes from the frozen snapshot 鈥?      // mirror the kill there or it would keep showing the settled state.
      if (handle.frozenSnapshot) {
        handle.frozenSnapshot = {
          ...handle.frozenSnapshot,
          lifecycle: handle.lifecycle,
          outcome: handle.lastOutcome,
          lastActivityAt: handle.lastActivityAt,
          running: false,
        };
      }
      this.deps.saveChildSession(handle);
      killed.push(name);

      const progress = this.deps.getProgress();
      if (progress) {
        progress.emit({
          step: this.deps.getTurnCount(),
          agent: name,
          action: "agent_killed",
          message: `  [#${handle.numericId} ${name}] archived`,
          level: "normal" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: {},
          extra: { sub_agent_id: handle.numericId },
        });
      }
    }

    const parts: string[] = [];
    if (killed.length) parts.push(`Killed: ${killed.join(", ")}.`);
    if (alreadyArchived.length) parts.push(`Already archived: ${alreadyArchived.join(", ")}.`);
    if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}.`);
    return new ToolResult({ content: parts.join(" ") });
  }

  /** send tool body: direct send, or revive an archived persistent agent. */
  async sendOrRevive(to: string, content: string): Promise<ToolResult> {
    // Direct send 鈥?may revive archived persistent agent
    if (!this._handles.has(to)) {
      const archived = this._archived.get(to);
      if (archived) {
        if (archived.mode !== "persistent") {
          return new ToolResult({ content: `Agent '${to}' is a one-shot agent and cannot be revived.` });
        }
        try {
          await this._reviveArchivedChild(archived, content);
          return new ToolResult({ content: `Agent '${to}' revived from archive and message sent.` });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return new ToolResult({ content: `Failed to revive agent '${to}': ${reason}` });
        }
      }
    }

    return this.sendMessageToChild(to, { type: "user_input", sender: "main", content, timestamp: Date.now() });
  }

  /** Revive an archived persistent child: rebuild Session, restore log, start turn. */
  private async _reviveArchivedChild(record: ArchivedChildRecord, messageContent: string): Promise<void> {
    let agent: Agent;
    if (this.deps.getAgentTemplates()[record.template]) {
      ({ agent } = this.deps.createFromPredefined(record.template, record.id));
    } else {
      ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id));
    }

    const handle = this.instantiateChild(
      record.id,
      record.template,
      record.mode,
      agent,
      { numericId: record.numericId, order: record.order },
    );

    // Restore log from disk
    const session = handle.session;
    if (!session) throw new Error(`freshly instantiated child '${record.id}' has no session`);
    const loaded = loadLog(record.sessionDir);
    const repaired = validateAndRepairLog(loaded.entries);
    session.restoreFromLog(loaded.meta, repaired.entries, loaded.idAllocator);
    handle.lifecycle = "idle";
    handle.lastOutcome = record.outcome;
    handle.lastActivityAt = Date.now();
    handle.resultText = extractLatestAssistantText(session.log);

    // Move from archived to active
    this._handles.set(record.id, handle);
    this._archived.delete(record.id);

    // Deliver message and start turn (standard delivery 鈥?see sendMessageToChild)
    this.deps.deliverToChild(session, {
      type: "user_input",
      sender: "main",
      content: messageContent,
      timestamp: Date.now(),
      wake: false,
    });
    this._startChildTurn(handle, "", { skipUserInput: true });

    // Trigger root save since child references changed
    this.deps.requestSave();
  }

  // ==================================================================
  // Staged child restore
  // ==================================================================

  prepareChildRestores(
    childSessions: ChildSessionMetaRecord[],
    warnings: string[],
  ): PreparedChildRestore[] {
    if (childSessions.length === 0) return [];

    const prepared: PreparedChildRestore[] = [];
    const ordered = [...childSessions].sort((a, b) => (a.order ?? a.numericId) - (b.order ?? b.numericId));
    for (const record of ordered) {
      let agent: Agent;
      try {
        if (this.deps.getAgentTemplates()[record.template]) {
          ({ agent } = this.deps.createFromPredefined(record.template, record.id));
        } else {
          ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to prepare child session '${record.id}': ${reason}`);
        continue;
      }

      const sessionDir = this.childSessionDir(record.id);
      const artifactsDir = join(sessionDir, "artifacts");

      try {
        const loaded = loadLog(sessionDir);
        const repaired = validateAndRepairLog(loaded.entries);
        if (repaired.repaired) {
          for (const warning of repaired.warnings) {
            warnings.push(`[repair:${record.id}] ${warning}`);
          }
        }
        prepared.push({
          record,
          agent,
          sessionDir,
          artifactsDir,
          loaded: {
            ...loaded,
            entries: repaired.entries,
          },
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to load child session '${record.id}': ${reason}`);
      }
    }
    return prepared;
  }

  commitPreparedChildren(children: PreparedChildRestore[]): string[] {
    if (children.length === 0) return [];

    const warnings: string[] = [];
    for (const prepared of children) {
      const { record, agent, loaded } = prepared;
      try {
        const handle = this.instantiateChild(
          record.id,
          record.template,
          record.mode,
          agent,
          { numericId: record.numericId, order: record.order },
        );
        const session = handle.session;
        if (!session) throw new Error("freshly instantiated child has no session");
        session.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
        handle.lifecycle = record.lifecycle;
        handle.lastOutcome = record.outcome ?? "none";
        handle.lastActivityAt = Date.now();
        handle.resultText = extractLatestAssistantText(session.log);
        handle.status =
          record.lifecycle === "archived"
            ? "terminated"
            : "idle";

        if (record.inbox && record.inbox.length > 0) {
          // For a settled one-shot the restored inbox is dropped at the
          // release below 鈥?benign: nothing can ever deliver to or drain a
          // one-shot archived inbox (pre-release it just sat unread).
          this.deps.setChildInbox(
            session,
            record.inbox.map((m) => migrateMessageEnvelope(m as unknown as Record<string, unknown>)),
          );
        }

        this._handles.set(record.id, handle);
        // Settled one-shot children come back released, same as live settle 鈥?        // the log was just loaded from this very disk copy.
        this._freezeAndRelease(handle, true);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to restore child session '${record.id}': ${reason}`);
      }
    }

    return warnings;
  }
}
