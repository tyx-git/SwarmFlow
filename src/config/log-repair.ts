/**
 * 恢复崩溃或异常终止的会话时，对日志条目做的校验与修复。
 */

import type { LogEntry } from "../context/entry/types.js";

// ------------------------------------------------------------------
// validateAndRepairLog——日志验证与修复
// ------------------------------------------------------------------

/** 日志修复结果 */
export interface LogRepairResult {
  /** 修复后的日志条目列表 */
  entries: LogEntry[];
  /** 是否进行了修复 */
  repaired: boolean;
  /** 修复过程中产生的警告信息 */
  warnings: string[];
}

/** 验证并修复日志条目，处理孤立的 compactPhase、缺失的 tool_result 等问题 */
export function validateAndRepairLog(
  entries: LogEntry[],
): LogRepairResult {
  const warnings: string[] = [];
  let repaired = false;

  if (!entries || entries.length === 0) {
    return { entries: entries ?? [], repaired: false, warnings: [] };
  }

  // --- 1. 孤立的 compactPhase 条目（后面没有 compact_marker）---
  {
    // 查找最后一个 compact_marker 的索引
    let lastCompactMarkerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_marker" && !entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }
    // 将最后一个 compact_marker 之后的 compactPhase 条目标记为丢弃
    for (let i = lastCompactMarkerIdx + 1; i < entries.length; i++) {
      if (entries[i].meta?.compactPhase && !entries[i].discarded) {
        entries[i].discarded = true;
        warnings.push(`Discarded orphaned compactPhase entry ${entries[i].id}.`);
        repaired = true;
      }
    }
  }

  // --- 2. 修复孤立的 tool_calls（缺少 tool_results）---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || entry.discarded) continue;
    if (entry.apiRole !== "assistant") continue;

    const toolCallId = entry.meta.toolCallId as string;
    // 检查是否有匹配的 tool_result
    let hasResult = false;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
        hasResult = true;
        break;
      }
    }
    if (!hasResult) {
      // 检查这是否是最后或接近最后的条目——可能是崩溃
      const isNearEnd = entries.length - i <= 5;
      if (isNearEnd) {
        const execState = entry.meta.toolExecState as string | undefined;
        const recoveredContent =
          execState === "running"
            ? "Session recovered. Tool execution was interrupted and may have caused partial or unknown real-world effects."
            : "Session recovered. Tool result unavailable due to abnormal termination.";
        // 添加恢复的 tool_result（需要 ID——使用可预测的格式）
        const recoveredId = `tr-recovered-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: entry.turnIndex,
          roundIndex: entry.roundIndex,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: entry.meta.toolName as string,
            content: recoveredContent,
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: entry.meta.toolName,
            isError: false,
            recovered: true,
            ...(entry.meta.contextId !== undefined ? { contextId: entry.meta.contextId } : {}),
          },
        };
        // Insert after the tool_call
        entries.splice(i + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result for tool_call ${entry.id} (${toolCallId}).`);
        repaired = true;
      }
    }
  }

  // --- 3. ask 修复 ---
  {
    // 构建 ask_request → ask_resolution 映射
    const askRequests = new Map<string, number>();
    const askResolutions = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.discarded) continue;
      if (e.type === "ask_request") {
        askRequests.set(e.meta.askId as string, i);
      } else if (e.type === "ask_resolution") {
        askResolutions.set(e.meta.askId as string, i);
      }
    }

    // 孤立的 ask_resolution（无匹配的 ask_request）→ 丢弃
    for (const [askId, idx] of askResolutions) {
      if (!askRequests.has(askId)) {
        entries[idx].discarded = true;
        warnings.push(`Discarded orphan ask_resolution ${entries[idx].id} (askId=${askId}).`);
        repaired = true;
      }
    }

    // ask_resolution 存在但无 tool_result → 添加恢复的 tool_result
    for (const [askId, resIdx] of askResolutions) {
      if (entries[resIdx].discarded) continue;
      const reqIdx = askRequests.get(askId);
      if (reqIdx === undefined) continue;

      const reqEntry = entries[reqIdx];
      const toolCallId = reqEntry.meta.toolCallId as string;
      if (!toolCallId) continue;

      // 检查解析后是否有此 toolCallId 的 tool_result
      let hasToolResult = false;
      for (let j = resIdx + 1; j < entries.length; j++) {
        if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
          hasToolResult = true;
          break;
        }
      }
      if (!hasToolResult) {
        const recoveredId = `tr-askrecv-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: reqEntry.turnIndex,
          roundIndex: reqEntry.meta.roundIndex as number | undefined,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            content: "Ask resolved. Session recovered from abnormal termination.",
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            isError: false,
            recovered: true,
            ...(reqEntry.meta.contextId !== undefined ? { contextId: reqEntry.meta.contextId } : {}),
          },
        };
        entries.splice(resIdx + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result after ask_resolution ${entries[resIdx].id} (askId=${askId}).`);
        repaired = true;
      }
    }
  }

  // --- 4. 修复因过时的 turnIndex 而与轮次分离的推理条目 ---
  // Pre-fix (see Session._runActivation / activationTurnIndex), a queued
  // message draining mid-activation could advance `_turnCount` so a round's
  // streamed `reasoning` got a higher turnIndex than its sibling tool_call /
  // tool_result entries. projectToApiMessages groups by (turnIndex, roundIndex),
  // so such reasoning becomes an orphan →a degenerate "thinking-only" assistant
  // message that strict backends (DeepSeek /anthropic) reject. Re-stamp an
  // orphaned reasoning entry to the turnIndex of its own round's action
  // entries. Tightly scoped: only fires when the reasoning's (turn,round) has
  // NO action sibling AND the round's real entries live under one other turn.
  {
    const ACTION_TYPES = new Set(["tool_call", "tool_result", "assistant_text", "no_reply"]);
    // 一次预扫描：只收未丢弃、roundIndex 明确的 action；reasoning 不参与索引。
    const actionKeys = new Set<string>();
    const roundTurns = new Map<number, Set<number>>();
    for (const entry of entries) {
      if (entry.discarded || entry.roundIndex === undefined) continue;
      if (!ACTION_TYPES.has(entry.type)) continue;
      actionKeys.add(`${entry.turnIndex}:${entry.roundIndex}`);
      let turns = roundTurns.get(entry.roundIndex);
      if (!turns) {
        turns = new Set<number>();
        roundTurns.set(entry.roundIndex, turns);
      }
      turns.add(entry.turnIndex);
    }

    for (const entry of entries) {
      if (entry.type !== "reasoning" || entry.discarded) continue;
      if (entry.roundIndex === undefined) continue;

      // 自己的 (turnIndex, roundIndex) 已有 action → 不孤立。
      if (actionKeys.has(`${entry.turnIndex}:${entry.roundIndex}`)) continue;
      const turns = roundTurns.get(entry.roundIndex);
      // 轮次的操作条目必须全部位于完全另一个 turn 下，否则无法明确选择。
      if (!turns || turns.size !== 1) continue;

      const targetTurn = turns.values().next().value as number;
      warnings.push(
        `Re-stamped orphaned reasoning ${entry.id} turnIndex ${entry.turnIndex} →${targetTurn} ` +
        `(round ${entry.roundIndex}; split by mid-activation turn drift).`,
      );
      entry.turnIndex = targetTurn;
      repaired = true;
    }
  }

  return { entries, repaired, warnings };
}
