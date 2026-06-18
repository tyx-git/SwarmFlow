/**
 * User-facing progress reporting.
 *
 * Provides a lightweight callback-based system for reporting session
 * progress to end users. Events include agent lifecycle, tool calls,
 * streaming text, context compaction, and sub-agent status.
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type ProgressLevel = "quiet" | "normal" | "verbose";

export interface ProgressEvent {
  step: number;
  agent: string;
  action: string;
  message: string;
  level: ProgressLevel;
  timestamp: number;
  usage: Record<string, number>;
  extra: Record<string, unknown>;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makeEvent(partial: Omit<ProgressEvent, "timestamp"> & { timestamp?: number }): ProgressEvent {
  return {
    ...partial,
    timestamp: partial.timestamp ?? Date.now() / 1000,
  };
}

// ------------------------------------------------------------------
// ProgressReporter
// ------------------------------------------------------------------

const STREAMING_ACTIONS = new Set(["text_chunk", "reasoning_chunk", "no_reply_clear"]);

export class ProgressReporter {
  callback?: ProgressCallback;
  level: ProgressLevel;
  messages: ProgressEvent[] = [];

  constructor(opts?: { callback?: ProgressCallback; level?: ProgressLevel }) {
    this.callback = opts?.callback;
    this.level = opts?.level ?? "normal";
  }

  /** Dispatch a progress event if it meets the verbosity threshold. */
  emit(event: ProgressEvent): void {
    // Filter by level
    if (this.level === "quiet") {
      if (event.level === "normal" || event.level === "verbose") return;
    } else if (this.level === "normal") {
      if (event.level === "verbose") return;
    }

    // Non-streaming events are stored; streaming events only trigger callback
    if (!STREAMING_ACTIONS.has(event.action)) {
      this.messages.push(event);
    }

    if (this.callback) {
      this.callback(event);
    }
  }

  // ------------------------------------------------------------------
  // Convenience emitters
  // ------------------------------------------------------------------

  onToolCall(
    step: number,
    agent: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    summary = "",
    extra?: Record<string, unknown>,
  ): void {
    const subId = extra?.["sub_agent_id"];
    const msg = subId !== undefined
      ? `  [#${subId} ${agent}] -> ${toolName}`
      : summary || `  [${agent}] -> ${toolName}(...)`;
    const evtExtra: Record<string, unknown> = { tool: toolName, args: toolArgs, summary };
    if (extra) Object.assign(evtExtra, extra);
    this.emit(makeEvent({
      step, agent, action: "tool_call",
      message: msg, level: "normal",
      usage: {}, extra: evtExtra,
    }));
  }

  onCompact(
    agent: string,
    originalTokens: number,
    compactedTokens: number,
    isPseudo = false,
  ): void {
    const label = isPseudo ? "pseudo-compact" : "compact";
    const ratio = originalTokens > 0 ? compactedTokens / originalTokens : 0;
    const pct = `${Math.round(ratio * 100)}%`;
    const msg = `  [${agent}] ${label}: ${originalTokens.toLocaleString()} -> ${compactedTokens.toLocaleString()} tokens (${pct})`;
    this.emit(makeEvent({
      step: 0, agent, action: label,
      message: msg, level: "normal",
      usage: {},
      extra: { original: originalTokens, compacted: compactedTokens, isPseudo },
    }));
  }

  onToolResult(
    step: number,
    agent: string,
    toolName: string,
    toolCallId: string,
    isError: boolean,
    summary = "",
  ): void {
    const msg = `  [${agent}] <- ${toolName}${isError ? " (error)" : ""}`;
    this.emit(makeEvent({
      step, agent, action: "tool_result",
      message: msg, level: "normal",
      usage: {}, extra: { tool: toolName, toolCallId, isError, summary },
    }));
  }

  // ------------------------------------------------------------------
  // Network retry emitters
  // ------------------------------------------------------------------

  onRetryAttempt(
    agent: string,
    attempt: number,
    maxRetries: number,
    delaySec: number,
    errorMessage: string,
  ): void {
    this.emit(makeEvent({
      step: 0, agent, action: "retry_attempt",
      message: `  [${agent}] network error, retrying (${attempt}/${maxRetries}, waiting ${delaySec}s)...`,
      level: "normal", usage: {},
      extra: { attempt, maxRetries, delaySec, errorMessage },
    }));
  }

  onRetrySuccess(agent: string, attempt: number): void {
    this.emit(makeEvent({
      step: 0, agent, action: "retry_success",
      message: `  [${agent}] retry succeeded (attempt ${attempt})`,
      level: "normal", usage: {}, extra: { attempt },
    }));
  }

  onRetryExhausted(agent: string, maxRetries: number, errorMessage: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "retry_exhausted",
      message: `  [${agent}] all ${maxRetries} retries failed: ${errorMessage}`,
      level: "normal", usage: {},
      extra: { maxRetries, errorMessage },
    }));
  }

  // ------------------------------------------------------------------
  // Compact lifecycle emitters
  // ------------------------------------------------------------------

  onCompactStart(agent: string, scenario: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "compact_start",
      message: `  [${agent}] compacting (${scenario})...`,
      level: "normal", usage: {}, extra: { scenario },
    }));
  }

  onCompactEnd(agent: string, scenario: string, originalTokens: number): void {
    this.emit(makeEvent({
      step: 0, agent, action: "compact_end",
      message: `  [${agent}] compacted: ${originalTokens.toLocaleString()} tokens`,
      level: "normal", usage: {}, extra: { scenario, originalTokens },
    }));
  }

  // ------------------------------------------------------------------
  // Agent lifecycle emitters
  // ------------------------------------------------------------------

  onAgentStart(wave: number, agent: string, extra?: Record<string, unknown>): void {
    const subId = extra?.["sub_agent_id"];
    let msg: string;
    let level: ProgressLevel;
    if (subId !== undefined) {
      msg = `  [#${subId} ${agent}] running...`;
      level = "normal";
    } else {
      msg = `  [${agent}] starting (wave ${wave})`;
      level = "verbose";
    }
    this.emit(makeEvent({
      step: wave, agent, action: "agent_start",
      message: msg, level,
      usage: {}, extra: extra ? { ...extra } : {},
    }));
  }

  onAgentEnd(
    wave: number,
    agent: string,
    elapsed: number,
    usage?: Record<string, number>,
    extra?: Record<string, unknown>,
  ): void {
    const subId = extra?.["sub_agent_id"];
    const msg = subId !== undefined
      ? `  [#${subId} ${agent}] done (${elapsed.toFixed(1)}s)`
      : `  [${agent}] done (${elapsed.toFixed(1)}s)`;
    const evtExtra: Record<string, unknown> = { elapsed };
    if (extra) Object.assign(evtExtra, extra);
    this.emit(makeEvent({
      step: wave, agent, action: "agent_end",
      message: msg, level: "normal",
      usage: usage ?? {}, extra: evtExtra,
    }));
  }

  // ------------------------------------------------------------------
  // NO_REPLY event emitters
  // ------------------------------------------------------------------

  onAgentNoReply(agent: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "agent_no_reply",
      message: `  [${agent}] -> NO_REPLY (waiting for messages)`,
      level: "normal", usage: {}, extra: {},
    }));
  }

  // ------------------------------------------------------------------
  // Streaming text events
  // ------------------------------------------------------------------

  onTextChunk(agent: string, chunk: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "text_chunk",
      message: chunk, level: "quiet",
      usage: {}, extra: { chunk },
    }));
  }

  onReasoningChunk(agent: string, chunk: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "reasoning_chunk",
      message: chunk, level: "quiet",
      usage: {}, extra: { chunk },
    }));
  }

  onNoReplyClear(agent: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "no_reply_clear",
      message: "", level: "quiet",
      usage: {}, extra: {},
    }));
  }
}

// ------------------------------------------------------------------
// ConsoleProgress
// ------------------------------------------------------------------

export class ConsoleProgress extends ProgressReporter {
  private _streamed = false;

  constructor(level: ProgressLevel = "normal") {
    super({ level });
    this.callback = this._printEvent.bind(this);
  }

  private _printEvent(event: ProgressEvent): void {
    if (event.action === "text_chunk") {
      process.stdout.write(event.extra["chunk"] as string ?? "");
      this._streamed = true;
    } else if (event.action === "reasoning_chunk") {
      const chunk = event.extra["chunk"] as string ?? "";
      if (chunk) {
        process.stdout.write(chunk);
        this._streamed = true;
      }
    } else if (event.action === "no_reply_clear") {
      // Silent event, no output needed
    } else {
      if (this._streamed) {
        process.stdout.write("\n");
        this._streamed = false;
      }
      console.log(event.message);
    }
  }

  /** Return true if text was streamed since last call, then reset. */
  popStreamed(): boolean {
    const result = this._streamed;
    this._streamed = false;
    return result;
  }
}
