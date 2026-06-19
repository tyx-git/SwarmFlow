/** @jsxImportSource @opentui/react */

// =============================================================================
// SwarmFlow GUI — 状态面板（Agent 列表 + Todo 列表）
// =============================================================================

import React from "react";
import { StyledText, RGBA, createTextAttributes, type TextChunk } from "@opentui/core";

import type { PlanCheckpoint } from "../../../src/plan-state.js";
import type { ChildSessionSnapshot } from "../../../src/session-tree-types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
import { SelectableRow } from "../primitives/selectable-row.js";
import { formatCompactTokensShort } from "../utils/format.js";

// ── 颜色规范 ─────────────────────────────────────────────────────────────────
const AGENT_TITLE_COLOR = "#b4a0ec"; // matches input-area agent badge
const TODO_TITLE_COLOR = "#86ded4";  // matches input-area todo badge

const TODO_COLORS = {
  doneMark: RGBA.fromHex("#4e6a88"),
  doneText: RGBA.fromHex("#4a4a58"),
  activeMark: RGBA.fromHex("#8ab4f8"),
  activeText: RGBA.fromHex("#d0d6e0"),
  pendingMark: RGBA.fromHex("#5a6a80"),
  pendingText: RGBA.fromHex("#7a8098"),
} as const;

const ATTRS_STRIKE = createTextAttributes({ strikethrough: true });

// 鈹€鈹€ Glyphs 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const MARK_DONE = "鉁?;
const MARK_ACTIVE = "鈻?;
const MARK_PENDING = "鈻?;

function chunk(text: string, fg?: RGBA, attributes?: number): TextChunk {
  return { __isChunk: true as const, text, fg, attributes };
}

// 鈹€鈹€ Types 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface StatusPanelProps {
  agents: readonly ChildSessionSnapshot[];
  showAgents: boolean;
  todos: readonly PlanCheckpoint[];
  showTodos: boolean;
  colors: ConversationPalette;
  contentWidth: number;
  terminalHeight: number;
  onAgentClick?: (agentId: string) => void;
}

// 鈹€鈹€ Agent rows (modal style) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function lifecycleIcon(lifecycle: string): string {
  switch (lifecycle) {
    case "running": return "鈼?;
    case "blocked": return "鈼?;
    case "idle": return "鈼?;
    default: return "鈼?;
  }
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "running": return "running";
    case "blocked": return "waiting";
    case "idle": return "idle";
    default: return "done";
  }
}

function agentStatusLabel(agent: ChildSessionSnapshot): string {
  if (agent.pendingAskKind === "approval") return "approval";
  if (agent.pendingAskKind === "agent_question") return "asking";
  return lifecycleLabel(agent.lifecycle);
}

function AgentRows({ agents, colors, onAgentClick }: { agents: readonly ChildSessionSnapshot[]; colors: ConversationPalette; onAgentClick?: (agentId: string) => void }): React.ReactNode {
  return (
    <>
      {agents.map((agent) => {
        const isActive = agent.lifecycle === "running";
        const isBlocked = agent.lifecycle === "blocked";
        const isWaitingForAsk = Boolean(agent.pendingAskKind);
        const statusColor = isWaitingForAsk || isBlocked ? colors.waitingStatus : isActive ? colors.workingStatus : "#5a6078";
        const nameColor = isActive || isBlocked ? colors.text : "#7a8098";
        const descColor = isActive || isBlocked ? colors.dim : "#5a6078";
        const icon = lifecycleIcon(agent.lifecycle);
        const label = agentStatusLabel(agent);
        const statsLine = `鈹?${agent.lifetimeToolCallCount} tools, ${formatCompactTokensShort(agent.lastTotalTokens)} tokens`;

        return (
          <SelectableRow
            key={agent.id}
            hoverBackgroundColor={colors.border}
            onPress={onAgentClick ? () => onAgentClick(agent.id) : undefined}
          >
            <box flexDirection="column" width="100%">
              <box flexDirection="row" width="100%">
                <text fg={statusColor} content={`${icon} `} flexShrink={0} />
                <text fg={nameColor} content={agent.id} flexShrink={1} truncate />
                <text fg={statusColor} content={` [${label}]`} flexShrink={0} />
                <box flexGrow={1} />
              </box>
              <box flexDirection="row" width="100%" paddingLeft={2}>
                <text fg={descColor} content={statsLine} truncate />
              </box>
            </box>
          </SelectableRow>
        );
      })}
    </>
  );
}

function clampPanelHeight(terminalHeight: number): number {
  return Math.max(2, Math.min(8, Math.floor((terminalHeight - 8) * 0.2)));
}

// 鈹€鈹€ Todo rows (plan-panel style) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function buildCheckpointStyledText(cp: PlanCheckpoint): StyledText {
  switch (cp.status) {
    case "done":
      return new StyledText([
        chunk(`${MARK_DONE} `, TODO_COLORS.doneMark),
        chunk(cp.text, TODO_COLORS.doneText, ATTRS_STRIKE),
      ]);
    case "active":
      return new StyledText([
        chunk(`${MARK_ACTIVE} `, TODO_COLORS.activeMark),
        chunk(cp.text, TODO_COLORS.activeText),
      ]);
    default:
      return new StyledText([
        chunk(`${MARK_PENDING} `, TODO_COLORS.pendingMark),
        chunk(cp.text, TODO_COLORS.pendingText),
      ]);
  }
}

function TodoRows({ todos }: { todos: readonly PlanCheckpoint[] }): React.ReactNode {
  const nonDone = todos.filter((cp) => cp.status !== "done");
  const done = todos.filter((cp) => cp.status === "done");
  const sorted = [...nonDone, ...done];

  return (
    <>
      {sorted.map((cp, i) => (
        <text
          key={i}
          content={buildCheckpointStyledText(cp)}
          truncate
        />
      ))}
    </>
  );
}

// 鈹€鈹€ Main panel 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function StatusPanelInner({
  agents,
  showAgents,
  todos,
  showTodos,
  colors,
  terminalHeight,
  onAgentClick,
}: StatusPanelProps): React.ReactNode {
  const openTodos = todos.filter((cp) => cp.status !== "done");
  const doneCount = todos.length - openTodos.length;
  const runningCount = agents.filter((a) => a.lifecycle === "running" || a.lifecycle === "blocked").length;

  const hasAgents = agents.length > 0 && showAgents;
  const hasTodos = todos.length > 0 && showTodos;

  if (!hasAgents && !hasTodos) return null;

  const maxHeight = clampPanelHeight(terminalHeight);

  const agentParts: string[] = [];
  if (runningCount > 0) agentParts.push(`${runningCount} running`);
  const doneAgentCount = agents.length - runningCount;
  if (doneAgentCount > 0) agentParts.push(`${doneAgentCount} done`);
  const agentTitle = `Agents (${agentParts.join(", ")})`;

  const todoParts: string[] = [];
  if (openTodos.length > 0) todoParts.push(`${openTodos.length} pending`);
  if (doneCount > 0) todoParts.push(`${doneCount} done`);
  const todoTitle = `Todos (${todoParts.join(", ")})`;

  if (hasAgents && hasTodos) {
    return (
      <box
        width="100%"
        flexShrink={0}
        maxHeight={maxHeight + 2}
        border={true}
        borderStyle="rounded"
        borderColor={colors.dim}
        title={agentTitle}
        titleColor={AGENT_TITLE_COLOR}
        dividerRatio={0.4}
        dividerTitle={todoTitle}
        dividerTitleColor={TODO_TITLE_COLOR}
        flexDirection="row"
        gap={0}
      >
        <scrollbox width="40%" flexShrink={0} paddingLeft={1} paddingRight={1} maxHeight={maxHeight} scrollY={true} fitContent={true}>
          <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />
        </scrollbox>
        <scrollbox flexGrow={1} paddingLeft={2} paddingRight={1} maxHeight={maxHeight} scrollY={true} fitContent={true}>
          <TodoRows todos={todos} />
        </scrollbox>
      </box>
    );
  }

  if (hasAgents) {
    return (
      <scrollbox
        width="100%"
        flexShrink={0}
        maxHeight={maxHeight + 2}
        scrollY={true}
        fitContent={true}
        border={true}
        borderStyle="rounded"
        borderColor={colors.dim}
        title={agentTitle}
        titleColor={AGENT_TITLE_COLOR}
        paddingLeft={1}
        paddingRight={1}
      >
        <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />
      </scrollbox>
    );
  }

  return (
    <scrollbox
      width="100%"
      flexShrink={0}
      maxHeight={maxHeight + 2}
      scrollY={true}
      fitContent={true}
      border={true}
      borderStyle="rounded"
      borderColor={colors.dim}
      title={todoTitle}
      titleColor={TODO_TITLE_COLOR}
      paddingLeft={1}
      paddingRight={1}
    >
      <TodoRows todos={todos} />
    </scrollbox>
  );
}

export const StatusPanel = React.memo(StatusPanelInner);
