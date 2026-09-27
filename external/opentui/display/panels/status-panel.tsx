/** @jsxImportSource @opentui/react */

import React from "react";
import { StyledText, RGBA, createTextAttributes, type TextChunk } from "@opentui/core";

import type { Task } from "../../../../src/lib/task-store.js";
import type { ChildSessionSnapshot } from "../../../../src/session-tree-types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
import { SelectableRow } from "../primitives/selectable-row.js";
import { formatCompactTokensShort } from "../utils/format.js";

const ATTRS_STRIKE = createTextAttributes({ strikethrough: true });

// ── Glyphs ──────────────────────────────────────────────────
const MARK_DONE = "✓";
const MARK_ACTIVE = "▶";
const MARK_PENDING = "▷";

function chunk(text: string, fg?: RGBA, attributes?: number): TextChunk {
  return { __isChunk: true as const, text, fg, attributes };
}

// ── Types ───────────────────────────────────────────────────

export interface StatusPanelProps {
  agents: readonly ChildSessionSnapshot[];
  showAgents: boolean;
  tasks: readonly Task[];
  showTasks: boolean;
  /**
   * 任务清单的持久化状态。只有 `"memory"`（本次会话确实没有存储）才显示提示；
   * `"file"` 与过渡态 `"pending"` 都不显示 —— 正常会话的界面不受影响。
   */
  taskPersistence?: "file" | "pending" | "memory";
  colors: ConversationPalette;
  contentWidth: number;
  terminalHeight: number;
  onAgentClick?: (agentId: string) => void;
}

// ── Agent rows (modal style) ────────────────────────────────

function lifecycleIcon(lifecycle: string): string {
  switch (lifecycle) {
    case "running": return "●";
    case "blocked": return "◐";
    case "idle": return "○";
    default: return "◌";
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
  // 重启对账后所有子代理统一落成 fail：lifecycle 多为 idle/archived，必须按 status 展示，
  // 否则会被 lifecycleLabel 显示成 "done"（误导）。
  if (agent.status === "error") {
    const resumable = agent.lifecycle === "idle";
    return resumable ? "failed · resumable" : "failed";
  }
  return lifecycleLabel(agent.lifecycle);
}

function AgentRows({ agents, colors, onAgentClick }: { agents: readonly ChildSessionSnapshot[]; colors: ConversationPalette; onAgentClick?: (agentId: string) => void }): React.ReactNode {
  return (
    <>
      {agents.map((agent) => {
        const isActive = agent.lifecycle === "running";
        const isBlocked = agent.lifecycle === "blocked";
        const isWaitingForAsk = Boolean(agent.pendingAskKind);
        const statusColor = isWaitingForAsk || isBlocked ? colors.waitingStatus : isActive ? colors.workingStatus : colors.textFaint;
        const nameColor = isActive || isBlocked ? colors.text : colors.textSecondary;
        const descColor = isActive || isBlocked ? colors.dim : colors.textFaint;
        const icon = lifecycleIcon(agent.lifecycle);
        const label = agentStatusLabel(agent);
        const statsLine = `└ ${agent.lifetimeToolCallCount} tools, ${formatCompactTokensShort(agent.lastTotalTokens)} tokens`;

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

// ── Task rows (pi-tasks style) ──────────────────────────────

/** 面板内可见的任务行上限；其余折叠成 `… and N more`（与 pi-tasks 的 maxVisible 一致）。 */
const MAX_VISIBLE_TASKS = 10;

const MARK_BLOCKED = "›";

/** 任务行的字形与配色：完成 ✔（删除线+暗）、进行中 ◼、待办 ◻。 */
function buildTaskStyledText(task: Task, openBlockers: readonly string[], colors: ConversationPalette): StyledText {
  const chunks: TextChunk[] = [];
  if (task.status === "completed") {
    chunks.push(chunk(`${MARK_DONE} `, RGBA.fromHex(colors.todoDoneMark)));
    chunks.push(chunk(`#${task.id} `, RGBA.fromHex(colors.todoDoneMark)));
    chunks.push(chunk(task.subject, RGBA.fromHex(colors.todoDoneText), ATTRS_STRIKE));
  } else if (task.status === "in_progress") {
    chunks.push(chunk(`${MARK_ACTIVE} `, RGBA.fromHex(colors.todoActiveMark)));
    chunks.push(chunk(`#${task.id} `, RGBA.fromHex(colors.textFaint)));
    chunks.push(chunk(task.activeForm || task.subject, RGBA.fromHex(colors.todoActiveText)));
  } else {
    chunks.push(chunk(`${MARK_PENDING} `, RGBA.fromHex(colors.todoPendingMark)));
    chunks.push(chunk(`#${task.id} `, RGBA.fromHex(colors.textFaint)));
    chunks.push(chunk(task.subject, RGBA.fromHex(colors.todoPendingText)));
  }
  if (openBlockers.length > 0) {
    chunks.push(
      chunk(
        `  ${MARK_BLOCKED} blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}`,
        RGBA.fromHex(colors.dim),
      ),
    );
  }
  return new StyledText(chunks);
}

function TaskRows({
  tasks,
  colors,
  taskPersistence,
}: {
  tasks: readonly Task[];
  colors: ConversationPalette;
  taskPersistence?: "file" | "pending" | "memory";
}): React.ReactNode {
  // 存储层已按 id 升序返回；这里把完成项沉到末尾，未完成保持 id 顺序。
  const open = tasks.filter((task) => task.status !== "completed");
  const done = tasks.filter((task) => task.status === "completed");
  const ordered = [...open, ...done];

  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const visible = ordered.slice(0, MAX_VISIBLE_TASKS);
  const hiddenCount = ordered.length - visible.length;

  return (
    <>
      {visible.map((task) => {
        const openBlockers = task.blockedBy.filter((id) => {
          const blocker = byId.get(id);
          return blocker !== undefined && blocker.status !== "completed";
        });
        return <text key={task.id} content={buildTaskStyledText(task, openBlockers, colors)} truncate />;
      })}
      {hiddenCount > 0 ? (
        <text
          content={new StyledText([chunk(`    … and ${hiddenCount} more`, RGBA.fromHex(colors.dim))])}
          truncate
        />
      ) : null}
      {taskPersistence === "memory" ? (
        <text
          content={new StyledText([
            chunk("    (not persisted — this session has no task storage)", RGBA.fromHex(colors.dim)),
          ])}
          truncate
        />
      ) : null}
    </>
  );
}

// ── Main panel ──────────────────────────────────────────────

function StatusPanelInner({
  agents,
  showAgents,
  tasks,
  showTasks,
  taskPersistence,
  colors,
  terminalHeight,
  onAgentClick,
}: StatusPanelProps): React.ReactNode {
  const openTasks = tasks.filter((task) => task.status !== "completed");
  const inProgressCount = tasks.filter((task) => task.status === "in_progress").length;
  const pendingCount = openTasks.length - inProgressCount;
  const doneCount = tasks.length - openTasks.length;
  const runningCount = agents.filter((a) => a.lifecycle === "running" || a.lifecycle === "blocked").length;

  const hasAgents = agents.length > 0 && showAgents;
  const hasTasks = tasks.length > 0 && showTasks;

  if (!hasAgents && !hasTasks) return null;

  const maxHeight = clampPanelHeight(terminalHeight);

  const agentParts: string[] = [];
  if (runningCount > 0) agentParts.push(`${runningCount} running`);
  const doneAgentCount = agents.length - runningCount;
  if (doneAgentCount > 0) agentParts.push(`${doneAgentCount} done`);
  const agentTitle = `Agents (${agentParts.join(", ")})`;

  // 汇总头与 pi-tasks 一致：`● N tasks (x done, y in progress, z open)`
  const taskParts: string[] = [];
  if (doneCount > 0) taskParts.push(`${doneCount} done`);
  if (inProgressCount > 0) taskParts.push(`${inProgressCount} in progress`);
  if (pendingCount > 0) taskParts.push(`${pendingCount} open`);
  const todoTitle = `● ${tasks.length} tasks (${taskParts.join(", ")})`;

  if (hasAgents && hasTasks) {
    return (
      <box
        width="100%"
        flexShrink={0}
        maxHeight={maxHeight + 2}
        border={true}
        borderStyle="rounded"
        borderColor={colors.dim}
        title={agentTitle}
        titleColor={colors.badgeAgentFg}
        dividerRatio={0.4}
        dividerTitle={todoTitle}
        dividerTitleColor={colors.badgeTodoFg}
        flexDirection="row"
        gap={0}
      >
        <scrollbox width="40%" flexShrink={0} paddingLeft={1} paddingRight={1} maxHeight={maxHeight} scrollY={true} fitContent={true}>
          <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />
        </scrollbox>
        <scrollbox flexGrow={1} paddingLeft={2} paddingRight={1} maxHeight={maxHeight} scrollY={true} fitContent={true}>
          <TaskRows tasks={tasks} colors={colors} taskPersistence={taskPersistence} />
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
        titleColor={colors.badgeAgentFg}
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
      titleColor={colors.badgeTodoFg}
      paddingLeft={1}
      paddingRight={1}
    >
      <TaskRows tasks={tasks} colors={colors} taskPersistence={taskPersistence} />
    </scrollbox>
  );
}

export const StatusPanel = React.memo(StatusPanelInner);
