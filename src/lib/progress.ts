/**
 * 面向用户的进度报告。
 *
 * 提供轻量的回调系统，用于向终端用户报告会话进度。
 * 事件包括代理生命周期、工具调用、流式文本、上下文压缩和子代理状态。
 */

// ------------------------------------------------------------------
// 类型定义
// ------------------------------------------------------------------

/** 进度级别 */
export type ProgressLevel = "quiet" | "normal" | "verbose";

/** 进度事件 */
export interface ProgressEvent {
  /** 步骤号 */
  step: number;
  /** 代理名称 */
  agent: string;
  /** 操作类型 */
  action: string;
  /** 事件消息 */
  message: string;
  /** 详细级别 */
  level: ProgressLevel;
  /** 时间戳（秒） */
  timestamp: number;
  /** Token 用量信息 */
  usage: Record<string, number>;
  /** 扩展字段 */
  extra: Record<string, unknown>;
}

/** 进度回调函数类型 */
export type ProgressCallback = (event: ProgressEvent) => void;

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/** 构造进度事件对象（自动填充时间戳） */
function makeEvent(partial: Omit<ProgressEvent, "timestamp"> & { timestamp?: number }): ProgressEvent {
  return {
    ...partial,
    timestamp: partial.timestamp ?? Date.now() / 1000,
  };
}

// ------------------------------------------------------------------
// ProgressReporter
// ------------------------------------------------------------------

/** 流式操作——这类事件不会存入 messages 列表 */
const STREAMING_ACTIONS = new Set(["text_chunk", "reasoning_chunk", "no_reply_clear"]);

export class ProgressReporter {
  callback?: ProgressCallback;
  level: ProgressLevel;
  messages: ProgressEvent[] = [];

  constructor(opts?: { callback?: ProgressCallback; level?: ProgressLevel }) {
    this.callback = opts?.callback;
    this.level = opts?.level ?? "normal";
  }

  /** 派发进度事件（若满足详细级别阈值则触发回调） */
  emit(event: ProgressEvent): void {
    // 按级别过滤
    if (this.level === "quiet") {
      if (event.level === "normal" || event.level === "verbose") return;
    } else if (this.level === "normal") {
      if (event.level === "verbose") return;
    }

    // 非流式事件存入列表，流式事件仅触发回调
    if (!STREAMING_ACTIONS.has(event.action)) {
      this.messages.push(event);
    }

    if (this.callback) {
      this.callback(event);
    }
  }

  // ------------------------------------------------------------------
  // 便捷发送方法
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
  // 网络重试发送方法
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
  // 压缩生命周期发送方法
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
  // 代理生命周期发送方法
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
  // NO_REPLY 事件发送方法
  // ------------------------------------------------------------------

  onAgentNoReply(agent: string): void {
    this.emit(makeEvent({
      step: 0, agent, action: "agent_no_reply",
      message: `  [${agent}] -> NO_REPLY (waiting for messages)`,
      level: "normal", usage: {}, extra: {},
    }));
  }

  // ------------------------------------------------------------------
  // 流式文本事件发送方法
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
// 控制台进度输出器
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
      // 静默事件，无需输出
    } else {
      if (this._streamed) {
        process.stdout.write("\n");
        this._streamed = false;
      }
      console.log(event.message);
    }
  }

  /** 返回自上次调用以来是否有文本流式输出过，然后重置。 */
  popStreamed(): boolean {
    const result = this._streamed;
    this._streamed = false;
    return result;
  }
}
