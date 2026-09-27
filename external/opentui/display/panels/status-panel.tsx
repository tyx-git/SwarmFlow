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
const MARK_DONE = "✔";
const MARK_PENDING = "□";
const TASK_SPINNER_FRAMES = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"] as const;
const TASK_SPINNER_INTERVAL_MS = 150;
const TASK_OPEN_TEXT = "#CCCCCC";
const TASK_ACTIVE_TEXT = "#8ABEB7";
const TASK_DONE_TEXT = "#535354";
const TASK_ID_TEXT = "#535354";
/** Header starts with "● "; indent row glyphs by those two display columns. */
const TASK_ROW_STATUS_INDENT = "  ";

export function taskSpinnerGlyph(frame: number): string {
  const index = ((frame % TASK_SPINNER_FRAMES.length) + TASK_SPINNER_FRAMES.length) % TASK_SPINNER_FRAMES.length;
  return TASK_SPINNER_FRAMES[index];
}

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

/** 任务滚动视口最多显示的行数；多余任务保留在滚动内容中。 */
export const MAX_VISIBLE_TASKS = 6;

export function taskViewportHeight(taskCount: number): number {
  return Math.min(Math.max(0, taskCount), MAX_VISIBLE_TASKS);
}

export function taskSummaryLabel(inProgressCount: number, openCount: number): string {
  return inProgressCount > 0 ? `${inProgressCount} in progress` : `${openCount} open`;
}

const MARK_BLOCKED = "›";

/** 任务行的字形与配色：完成 ✔（成功色+删除线）、进行中旋转星标、待办 ◻。 */
function buildTaskStyledText(
  task: Task,
  openBlockers: readonly string[],
  colors: ConversationPalette,
  spinnerGlyph: string,
): StyledText {
  const chunks: TextChunk[] = [chunk(TASK_ROW_STATUS_INDENT)];
  const idColor = RGBA.fromHex(TASK_ID_TEXT);
  if (task.status === "completed") {
    chunks.push(chunk(`${MARK_DONE} `, RGBA.fromHex(TASK_DONE_TEXT)));
    chunks.push(chunk(`#${task.id} `, idColor));
    chunks.push(chunk(task.subject, RGBA.fromHex(TASK_DONE_TEXT), ATTRS_STRIKE));
  } else if (task.status === "in_progress") {
    chunks.push(chunk(`${spinnerGlyph} `, RGBA.fromHex(colors.todoActiveMark)));
    chunks.push(chunk(`#${task.id} `, idColor));
    chunks.push(chunk(task.activeForm || task.subject, RGBA.fromHex(TASK_ACTIVE_TEXT)));
  } else {
    chunks.push(chunk(`${MARK_PENDING} `, RGBA.fromHex(colors.todoPendingMark)));
    chunks.push(chunk(`#${task.id} `, idColor));
    chunks.push(chunk(task.subject, RGBA.fromHex(TASK_OPEN_TEXT)));
  }
  if (openBlockers.length > 0) {
    chunks.push(
      chunk(
        `  ${MARK_BLOCKED} blocked by ${openBlockers.join(", ")}`,
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
  spinnerFrame,
}: {
  tasks: readonly Task[];
  colors: ConversationPalette;
  taskPersistence?: "file" | "pending" | "memory";
  spinnerFrame: number;
}): React.ReactNode {
  // 存储层已按 id 升序返回；这里把完成项沉到末尾，未完成保持 id 顺序。
  const open = tasks.filter((task) => task.status !== "completed");
  const done = tasks.filter((task) => task.status === "completed");
  const ordered = [...open, ...done];

  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  return (
    <>
      {ordered.map((task) => {
        const openBlockers = task.blockedBy.filter((id) => {
          const blocker = byId.get(id);
          return blocker !== undefined && blocker.status !== "completed";
        });
        const spinnerGlyph = taskSpinnerGlyph(spinnerFrame);
        return <text key={task.id} content={buildTaskStyledText(task, openBlockers, colors, spinnerGlyph)} truncate />;
      })}
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
  const runningCount = agents.filter((a) => a.lifecycle === "running" || a.lifecycle === "blocked").length;
  const [spinnerFrame, setSpinnerFrame] = React.useState(0);

  React.useEffect(() => {
    if (inProgressCount === 0) {
      setSpinnerFrame(0);
      return undefined;
    }
    const timer = setInterval(() => setSpinnerFrame((frame) => frame + 1), TASK_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [inProgressCount]);

  const hasAgents = agents.length > 0 && showAgents;
  const hasTasks = tasks.length > 0 && showTasks;

  if (!hasAgents && !hasTasks) return null;

  const maxHeight = clampPanelHeight(terminalHeight);

  const agentParts: string[] = [];
  if (runningCount > 0) agentParts.push(`${runningCount} running`);
  const doneAgentCount = agents.length - runningCount;
  if (doneAgentCount > 0) agentParts.push(`${doneAgentCount} done`);
  const agentTitle = `Agents (${agentParts.join(", ")})`;

  // pi-tasks 风格的单行标题，不绘制包围容器或横线。
  const todoTitle = `● ${tasks.length} tasks (${taskSummaryLabel(inProgressCount, openTasks.length)})`;
  const taskContentHeight = taskViewportHeight(tasks.length) + (taskPersistence === "memory" ? 1 : 0);

  if (hasAgents && hasTasks) {
    return (
      <box width="100%" flexShrink={0} maxHeight={maxHeight + 1} flexDirection="row" gap={0}>
        <box width="40%" flexShrink={0} flexDirection="column">
          <text fg={colors.badgeAgentFg} content={agentTitle} />
          <scrollbox maxHeight={maxHeight} scrollY={true} fitContent={true}>
            <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />
          </scrollbox>
        </box>
        <box flexGrow={1} flexShrink={0} flexDirection="column">
          <text fg={colors.badgeTodoFg} content={todoTitle} />
          <scrollbox
            height={Math.max(1, taskContentHeight)}
            maxHeight={maxHeight}
            scrollY={true}
            fitContent={true}
          >
            <TaskRows
              tasks={tasks}
              colors={colors}
              taskPersistence={taskPersistence}
              spinnerFrame={spinnerFrame}
            />
          </scrollbox>
        </box>
      </box>
    );
  }

  if (hasAgents) {
    return (
      <box width="100%" flexShrink={0} flexDirection="column">
        <text fg={colors.badgeAgentFg} content={agentTitle} />
        <scrollbox maxHeight={maxHeight} scrollY={true} fitContent={true}>
          <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />
        </scrollbox>
      </box>
    );
  }

  return (
    <box width="100%" flexShrink={0} flexDirection="column">
      <text fg={colors.badgeTodoFg} content={todoTitle} />
      <scrollbox
        height={Math.max(1, taskContentHeight)}
        maxHeight={maxHeight}
        scrollY={true}
        fitContent={true}
      >
        <TaskRows
          tasks={tasks}
          colors={colors}
          taskPersistence={taskPersistence}
          spinnerFrame={spinnerFrame}
        />
      </scrollbox>
    </box>
  );
}

export const StatusPanel = React.memo(StatusPanelInner);
