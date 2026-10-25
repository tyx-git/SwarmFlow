/**
 * 日志条目 ID 的分配器：按类型前缀生成单调递增 ID，并支持从已加载条目恢复。
 */

import type { LogEntry, LogEntryType } from "./types.js";

/** 日志条目类型到 ID 前缀的映射 */
const TYPE_PREFIX_MAP: Record<LogEntryType, string> = {
  system_prompt: "sys",
  work_start: "ws",
  work_end: "we",
  input_received: "in",
  turn_start: "ts",
  turn_end: "te",
  user_message: "user",
  agent_result: "ar",
  assistant_text: "asst",
  reasoning: "rsn",
  tool_call: "tc",
  tool_result: "tr",
  ask_request: "askq",
  ask_resolution: "askr",
  no_reply: "nr",
  compact_marker: "cm",
  compact_context: "cc",
  summary: "sum",
  interruption_marker: "int",
  sub_agent_start: "sas",
  sub_agent_tool_call: "satc",
  sub_agent_end: "sae",
  status: "st",
  error: "err",
  token_update: "tok",
};

/**
 * 生成顺序 ID，如 "user-001"、"tc-005"。
 * 维护每个前缀的计数器。
 */
export class LogIdAllocator {
  private _counters = new Map<string, number>();

  /** 为指定条目类型分配下一个 ID */
  next(type: LogEntryType): string {
    const prefix = TYPE_PREFIX_MAP[type];
    const count = (this._counters.get(prefix) ?? 0) + 1;
    this._counters.set(prefix, count);
    return `${prefix}-${String(count).padStart(3, "0")}`;
  }

  /**
   * 从现有日志恢复计数器（例如 loadLog 之后）。
   * 扫描所有条目并将每个前缀计数器设置为看到的最大值。
   */
  restoreFrom(entries: LogEntry[]): void {
    this._counters.clear();
    this.mergeFrom(entries);
  }

  /** 与 restoreFrom 相同但不先清零：用于把"窗口内最大值"合并到持久化计数器之上。 */
  mergeFrom(entries: readonly LogEntry[]): void {
    for (const entry of entries) {
      const dashIdx = entry.id.lastIndexOf("-");
      if (dashIdx === -1) continue;
      const prefix = entry.id.slice(0, dashIdx);
      const num = parseInt(entry.id.slice(dashIdx + 1), 10);
      if (!isNaN(num)) {
        const current = this._counters.get(prefix) ?? 0;
        if (num > current) {
          this._counters.set(prefix, num);
        }
      }
    }
  }

  /** 前缀 → 已用最大序号；写入 meta.json，供有界恢复保持追加安全。 */
  snapshotCounters(): Record<string, number> {
    return Object.fromEntries(this._counters);
  }

  /** 从 meta.json 恢复计数器；只接受非负整数，且只向上合并。 */
  restoreCounters(counters: Record<string, number> | undefined): void {
    if (!counters) return;
    for (const [prefix, count] of Object.entries(counters)) {
      if (!Number.isInteger(count) || count < 0) continue;
      if (count > (this._counters.get(prefix) ?? 0)) {
        this._counters.set(prefix, count);
      }
    }
  }

  /** 获取前缀的当前计数器值（用于测试） */
  getCounter(type: LogEntryType): number {
    const prefix = TYPE_PREFIX_MAP[type];
    return this._counters.get(prefix) ?? 0;
  }
}

// ------------------------------------------------------------------
// 工厂辅助函数
// ------------------------------------------------------------------

