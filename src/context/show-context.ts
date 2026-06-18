/**
 * show_context tool implementation.
 *
 * Generates a self-contained Context Map for the tool_result.
 * All information (context IDs, sizes, types, content previews) is
 * returned in the tool result 鈥?nothing is injected into existing
 * messages, preserving prompt cache.
 */

import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";
import type { LogEntry } from "./context/log-entry.js";
import { buildActiveContextView, type ActiveContextGroup } from "./context/active-context.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ContextGroup {
  contextId: string;
  entries: Array<{ entry: LogEntry; index: number }>;
  totalTokens: number;
  /** Per-entry token estimates. */
  entryTokens: number[];
}

// ------------------------------------------------------------------
// Token display helpers
// ------------------------------------------------------------------

function formatTokens(tokens: number): string {
  if (tokens < 1000) return "<1k";
  return `~${Math.round(tokens / 1000)}k`;
}

// ------------------------------------------------------------------
// Entry content serialization for token estimation
// ------------------------------------------------------------------

export function estimateEntryTokens(entry: LogEntry): number {
  let text: string;
  switch (entry.type) {
    case "user_message":
    case "assistant_text":
    case "no_reply":
    case "compact_context":
    case "summary":
      text = serializeContent(entry.content);
      break;
    case "reasoning":
      text = serializeContent(entry.content);
      break;
    case "tool_call":
      text = JSON.stringify(entry.content ?? {});
      break;
    case "tool_result": {
      const rc = entry.content as { content?: string } | null;
      text = rc?.content ?? JSON.stringify(entry.content ?? {});
      break;
    }
    default:
      text = serializeContent(entry.content);
      break;
  }
  return gptEncode(text).length;
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "image" || block?.type === "image_ref") return "[image]";
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

// ------------------------------------------------------------------
// Text truncation
// ------------------------------------------------------------------

function truncateText(text: string, maxLen = 60): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= maxLen) return `"${clean}"`;
  return `"${clean.slice(0, maxLen)}..."`;
}

// ------------------------------------------------------------------
// Group classification
// ------------------------------------------------------------------

type GroupKind = "user message" | "assistant" | "tool call" | "system" | "summary" | "compact" | "other";

function classifyGroup(group: ActiveContextGroup): GroupKind {
  for (const { entry } of group.entries) {
    if (entry.type === "summary") return "summary";
    if (entry.type === "compact_context") return "compact";
  }
  for (const { entry } of group.entries) {
    if (entry.type === "user_message") {
      const inputKind = (entry.meta as Record<string, unknown>)["inputKind"];
      if (inputKind === "system" || inputKind === "peer") return "system";
      return "user message";
    }
  }
  for (const { entry } of group.entries) {
    if (entry.type === "tool_call") return "tool call";
  }
  for (const { entry } of group.entries) {
    if (entry.type === "assistant_text") return "assistant";
  }
  return "other";
}

// ------------------------------------------------------------------
// Group detail line (second line under the header)
// ------------------------------------------------------------------

function formatGroupDetail(group: ActiveContextGroup): string[] {
  const kind = classifyGroup(group);
  switch (kind) {
    case "user message": {
      const userEntry = group.entries.find(e => e.entry.type === "user_message");
      if (!userEntry) return [];
      const text = serializeContent(userEntry.entry.content);
      const hasImage = Array.isArray(userEntry.entry.content) &&
        (userEntry.entry.content as Array<Record<string, unknown>>).some(
          b => b?.type === "image" || b?.type === "image_ref",
        );
      const prefix = hasImage ? "[image] " : "";
      return [`  ${prefix}${truncateText(text)}`];
    }
    case "assistant": {
      const asstEntry = group.entries.find(e => e.entry.type === "assistant_text");
      if (!asstEntry) return [];
      return [`  ${truncateText(serializeContent(asstEntry.entry.content))}`];
    }
    case "system": {
      const sysEntry = group.entries.find(e => e.entry.type === "user_message");
      if (!sysEntry) return [];
      return [`  ${truncateText(serializeContent(sysEntry.entry.content))}`];
    }
    case "tool call": {
      const lines: string[] = [];
      const calls = group.entries.filter(e => e.entry.type === "tool_call");
      const results = group.entries.filter(e => e.entry.type === "tool_result");
      for (let i = 0; i < calls.length; i++) {
        const tc = calls[i].entry.content as { name?: string; arguments?: Record<string, unknown> } | null;
        const name = String(tc?.name ?? (calls[i].entry.meta as Record<string, unknown>)["toolName"] ?? "unknown");
        const args = tc?.arguments ?? {};
        const argsBrief = formatToolCallArgs(name, args);
        const matchingResult = results.find(r =>
          (r.entry.meta as Record<string, unknown>)["toolCallId"] ===
          (calls[i].entry.meta as Record<string, unknown>)["toolCallId"],
        );
        let resultBrief = "";
        if (matchingResult) {
          const isError = (matchingResult.entry.meta as Record<string, unknown>)["isError"] === true;
          const rc = matchingResult.entry.content as { content?: string } | null;
          const resultStr = rc?.content ?? "";
          resultBrief = isError
            ? `ERROR: ${resultStr.slice(0, 60).replace(/\n/g, " ")}`
            : formatToolResultBrief(name, resultStr);
        }
        const line = resultBrief
          ? `  ${name}(${argsBrief}) 鈫?${resultBrief}`
          : `  ${name}(${argsBrief})`;
        lines.push(line);
      }
      return lines;
    }
    case "summary": {
      const summaryEntry = group.entries.find(e => e.entry.type === "summary");
      if (!summaryEntry) return [];
      return [`  ${truncateText(serializeContent(summaryEntry.entry.content), 80)}`];
    }
    case "compact": {
      return [`  "Auto-compact summary"`];
    }
    default:
      return [];
  }
}

// ------------------------------------------------------------------
// Tool call argument formatting (per-tool)
// ------------------------------------------------------------------

function formatToolCallArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file": {
      const path = String(args["path"] ?? args["file"] ?? "");
      const parts = [path ? `"${path}"` : ""];
      if (args["start_line"] !== undefined) parts.push(`${args["start_line"]}鈥?{args["end_line"] ?? "end"}`);
      return parts.filter(Boolean).join(", ");
    }
    case "edit_file":
    case "write_file":
      return `"${String(args["path"] ?? args["file"] ?? "")}"`;
    case "bash":
    case "bash_background":
    case "bash_output":
      return truncateText(String(args["command"] ?? ""), 40).slice(1, -1);
    case "grep":
      return `"${String(args["pattern"] ?? "")}", path="${String(args["path"] ?? "")}"`;
    case "glob":
      return `"${String(args["pattern"] ?? "")}"`;
    case "list_dir":
      return `"${String(args["path"] ?? args["dir"] ?? "")}"`;
    case "spawn":
      return `${String(args["id"] ?? "")} [${String(args["template"] ?? args["template_path"] ?? "")}]`;
    case "kill_agent":
      return `${String(args["id"] ?? "")}`;
    case "ask": {
      const qs = args["questions"] as Array<Record<string, unknown>> | undefined;
      if (qs?.length) return truncateText(String(qs[0]?.question ?? ""), 30).slice(1, -1);
      return "...";
    }
    case "summarize_context": {
      const ops = args["operations"] as unknown[] | undefined;
      return `${ops?.length ?? 0} operations`;
    }
    case "show_context":
      return "";
    case "web_search":
    case "web_search_exa":
      return truncateText(String(args["query"] ?? ""), 40).slice(1, -1);
    case "web_fetch":
      return truncateText(String(args["url"] ?? ""), 50).slice(1, -1);
    case "send":
      return `to=${String(args["to"] ?? "")}`;
    case "check_status":
      return `${String(args["id"] ?? "")}`;
    case "kill_shell":
      return `${String(args["id"] ?? "")}`;
    default: {
      const keys = Object.keys(args).slice(0, 3);
      if (keys.length === 0) return "";
      return keys.map(k => {
        const v = String(args[k] ?? "");
        if (v.length > 30) return `${k}="${v.slice(0, 30)}..."`;
        return `${k}="${v}"`;
      }).join(", ");
    }
  }
}

// ------------------------------------------------------------------
// Tool result brief formatting (per-tool)
// ------------------------------------------------------------------

function formatToolResultBrief(toolName: string, resultStr: string): string {
  switch (toolName) {
    case "read_file":
      return `${resultStr.length} chars`;
    case "edit_file":
      return resultStr.includes("applied") || resultStr.includes("OK") ? "applied" : `${resultStr.length} chars`;
    case "write_file":
      return "created";
    case "bash":
    case "bash_background":
    case "bash_output": {
      const exitMatch = resultStr.match(/exit (?:code |status )?(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : null;
      const size = formatTokens(gptEncode(resultStr).length);
      return exitCode !== null ? `exit ${exitCode}, ${size} output` : `${size} output`;
    }
    case "grep": {
      const lineCount = resultStr.split("\n").filter(Boolean).length;
      return `${lineCount} matches`;
    }
    case "glob": {
      const lineCount = resultStr.split("\n").filter(Boolean).length;
      return `${lineCount} files`;
    }
    case "list_dir": {
      const lineCount = resultStr.split("\n").filter(Boolean).length;
      return `${lineCount} entries`;
    }
    case "ask": {
      const brief = resultStr.replace(/\n/g, " ").trim();
      return brief.length > 40 ? `${brief.slice(0, 40)}...` : brief;
    }
    case "web_search":
    case "web_search_exa": {
      const lineCount = resultStr.split("\n").filter(Boolean).length;
      return `${lineCount} results`;
    }
    case "web_fetch":
      return `${resultStr.length} chars`;
    case "spawn":
      return "agent started";
    case "kill_agent":
      return "agent killed";
    case "check_status": {
      const brief = resultStr.replace(/\n/g, " ").trim();
      return brief.length > 40 ? `${brief.slice(0, 40)}...` : brief;
    }
    case "show_context": {
      const match = resultStr.match(/(\d+) groups/);
      return match ? `${match[1]} groups` : "ok";
    }
    case "summarize_context": {
      const match = resultStr.match(/(\d+) operation/);
      return match ? `${match[1]} operations` : "ok";
    }
    case "send":
      return "sent";
    case "kill_shell":
      return "shell killed";
    case "time": {
      const brief = resultStr.replace(/\n/g, " ").trim();
      return brief.length > 40 ? `${brief.slice(0, 40)}...` : brief;
    }
    default:
      return `${formatTokens(gptEncode(resultStr).length)} output`;
  }
}

// ------------------------------------------------------------------
// Context group builder
// ------------------------------------------------------------------

/**
 * Build context groups from log entries in the active window.
 * Returns groups in spatial (appearance) order.
 */
export function buildContextGroups(entries: LogEntry[]): ContextGroup[] {
  const view = buildActiveContextView(entries, { includeCompactContext: true });
  return view.groups.map((group) => {
    const entryTokens = group.entries.map(({ entry }) => estimateEntryTokens(entry));
    return {
      contextId: group.contextId,
      entries: group.entries,
      totalTokens: entryTokens.reduce((sum, value) => sum + value, 0),
      entryTokens,
    };
  });
}

// ------------------------------------------------------------------
// Context Map generation (self-contained, for tool_result)
// ------------------------------------------------------------------

function formatSummaryMeta(group: ActiveContextGroup): string {
  const parts: string[] = ["summary"];
  if (group.summaryDepth !== undefined) parts.push(`depth ${group.summaryDepth}`);
  if (group.summaryOrigin) parts.push(group.summaryOrigin);
  if (group.coveredContextIds && group.coveredContextIds.length > 0) {
    const ids = group.coveredContextIds;
    if (ids.length === 1) {
      parts.push(`covers ${ids[0]}`);
    } else {
      parts.push(`covers ${ids[0]}..${ids[ids.length - 1]}`);
    }
  }
  return parts.join(" 路 ");
}

export function generateContextMap(
  groups: ActiveContextGroup[],
  tokensByGroup: Map<string, number>,
  lastInputTokens: number,
  budget: number,
): string {
  const lines: string[] = [];
  const pct = budget > 0 ? Math.round((lastInputTokens / budget) * 100) : 0;
  lines.push(`Context Map 路 ${groups.length} groups 路 ${formatTokens(lastInputTokens)} / ${formatTokens(budget)} tokens (${pct}%)`);

  let lastTurnEnd = -1;
  for (const group of groups) {
    // Summaries display under their assigned turn (the nearest preceding
    // surviving user message), not under the turns they cover.
    const turnStart = group.isSummary ? group.assignedTurn : group.turnStart;
    const turnEnd = group.isSummary ? group.assignedTurn : group.turnEnd;
    if (turnStart !== lastTurnEnd || lastTurnEnd === -1) {
      lines.push("---");
    }
    lastTurnEnd = turnEnd;

    const tokens = tokensByGroup.get(group.contextId) ?? 0;
    const tokStr = formatTokens(tokens).padStart(5);
    const kind = classifyGroup(group);

    let label: string;
    if (kind === "summary") {
      label = formatSummaryMeta(group);
    } else {
      label = kind;
    }

    lines.push(`[${group.contextId}] ${tokStr} 路 ${label}`);

    const detail = formatGroupDetail(group);
    for (const line of detail) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

// ------------------------------------------------------------------
// Combined entry point
// ------------------------------------------------------------------

export function generateShowContext(
  entries: LogEntry[],
  lastInputTokens: number,
  budget: number,
): string {
  const view = buildActiveContextView(entries, { includeCompactContext: true });
  const tokensByGroup = new Map<string, number>();
  for (const group of view.groups) {
    const total = group.entries.reduce((sum, { entry }) => sum + estimateEntryTokens(entry), 0);
    tokensByGroup.set(group.contextId, total);
  }
  return generateContextMap(view.groups, tokensByGroup, lastInputTokens, budget);
}
