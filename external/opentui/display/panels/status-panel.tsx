/** @jsxImportSource @opentui/react */

import React from "react";
import { StyledText, RGBA, createTextAttributes, type TextChunk } from "@opentui/core";

import type { Task } from "../../../../src/lib/task-store.js";
import type { ChildSessionSnapshot } from "../../../../src/session-tree-types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
import { SelectableRow } from "../primitives/selectable-row.js";
import { formatCompactTokensShort } from "../utils/format.js";
import { getCommonColors } from "../theme/color-config.js";
import { useShimmer } from "../../presentation/use-shimmer.js";

const ATTRS_STRIKE = createTextAttributes({ strikethrough: true });

// ── Glyphs ──────────────────────────────────────────────────
const MARK_DONE = "✔";
const MARK_PENDING = "□";
const TASK_SPINNER_FRAMES = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"] as const;
const TASK_SPINNER_INTERVAL_MS = 150;
const COMMON_COLORS = getCommonColors();
const TASK_OPEN_TEXT = COMMON_COLORS.taskOpenText;
const TASK_ACTIVE_TEXT = COMMON_COLORS.taskActiveText;
const TASK_DONE_TEXT = COMMON_COLORS.taskDoneText;
const TASK_ID_TEXT = COMMON_COLORS.taskIdText;
/** Header starts with "● "; indent row glyphs by those two display columns. */
const TASK_ROW_STATUS_INDENT = "  ";
const STATUS_PANEL_TITLE_COLOR = COMMON_COLORS.workingStatus;
const AGENT_ROW_HEIGHT = 2;

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

function agentIsCompleted(agent: ChildSessionSnapshot): boolean {
  return agent.status === "completed" || agent.outcome === "completed";
}

function agentIsFailed(agent: ChildSessionSnapshot): boolean {
  return agent.status === "error" || agent.status === "terminated" || agent.outcome === "error";
}

function agentIsInterrupted(agent: ChildSessionSnapshot): boolean {
  return agent.status === "interrupted" || agent.outcome === "interrupted";
}

function AgentRow({
  agent,
  colors,
  onAgentClick,
}: {
  agent: ChildSessionSnapshot;
  colors: ConversationPalette;
  onAgentClick?: (agentId: string) => void;
}): React.ReactNode {
  const isTerminalSuccess = agentIsCompleted(agent);
  const isTerminalFailure = !isTerminalSuccess && (agentIsFailed(agent) || agentIsInterrupted(agent));
  const isActive = !isTerminalSuccess && !isTerminalFailure && (agent.running || agent.lifecycle === "running");
  const isWaitingForAsk = Boolean(agent.pendingAskKind) || agent.lifecycle === "blocked";
  const statusColor = isTerminalSuccess
    ? colors.green
    : isTerminalFailure
      ? colors.red
      : isWaitingForAsk
        ? colors.waitingStatus
        : isActive
          ? colors.workingStatus
          : colors.textFaint;
  const nameColor = isActive || isWaitingForAsk ? colors.text : colors.textSecondary;
  const descColor = isActive || isWaitingForAsk ? colors.dim : colors.textFaint;
  const shimmer = useShimmer("● ", RGBA.fromHex(statusColor), isActive);
  const statsLine = `└ ${agent.lifetimeToolCallCount} tools, ${formatCompactTokensShort(agent.lastTotalTokens)} tokens`;

  return (
    <SelectableRow
      key={agent.id}
      hoverBackgroundColor={colors.border}
      onPress={onAgentClick ? () => onAgentClick(agent.id) : undefined}
    >
      <box flexDirection="column" width="100%">
        <box flexDirection="row" width="100%">
          {isActive ? (
            <text content={shimmer} flexShrink={0} />
          ) : (
            <text fg={statusColor} content={`${isWaitingForAsk ? "◐" : "●"} `} flexShrink={0} />
          )}
          <text fg={nameColor} content={agent.id} flexShrink={1} truncate />
          <box flexGrow={1} />
        </box>
        <box flexDirection="row" width="100%" paddingLeft={2}>
          <text fg={descColor} content={statsLine} truncate />
        </box>
      </box>
    </SelectableRow>
  );
}

function AgentRows({ agents, colors, onAgentClick }: { agents: readonly ChildSessionSnapshot[]; colors: ConversationPalette; onAgentClick?: (agentId: string) => void }): React.ReactNode {
  return (
    <>
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} colors={colors} onAgentClick={onAgentClick} />
      ))}
    </>
  );
}

function clampPanelHeight(terminalHeight: number): number {
  return Math.max(2, Math.min(8, Math.floor((terminalHeight - 8) * 0.2)));
}

// ── Task rows (pi-tasks style) ──────────────────────────────

/** 任务滚动视口最多显示的行数；多余任务保留在滚动内容中。 */
export const MAX_VISIBLE_TASKS = 4;
export const MAX_VISIBLE_AGENTS = 3;

export function taskViewportHeight(taskCount: number): number {
  return Math.min(Math.max(0, taskCount), MAX_VISIBLE_TASKS);
}

export function agentViewportHeight(agentCount: number): number {
  return Math.min(Math.max(0, agentCount), MAX_VISIBLE_AGENTS) * AGENT_ROW_HEIGHT;
}

export function statusPanelBodyHeight(taskContentHeight: number, agentContentHeight: number, maxHeight: number): number {
  return Math.min(Math.max(1, maxHeight), Math.max(taskContentHeight, agentContentHeight));
}

function StatusPanelTitle({
  text,
  colors,
  onToggle,
}: {
  text: string;
  colors: ConversationPalette;
  onToggle: () => void;
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false);

  return (
    <box
      width="auto"
      alignSelf="flex-start"
      flexDirection="row"
      flexShrink={0}
      cursor="pointer"
      backgroundColor={hovered ? colors.border : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event: any) => {
        event.stopPropagation();
        event.preventDefault();
        onToggle();
      }}
    >
      <text fg={STATUS_PANEL_TITLE_COLOR} content={text} />
    </box>
  );
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

/** Keep short task lists tightly sized; only overflowing lists need a scrollbox. */
function TaskList({
  tasks,
  colors,
  taskPersistence,
  spinnerFrame,
  taskContentHeight,
  maxHeight,
}: {
  tasks: readonly Task[];
  colors: ConversationPalette;
  taskPersistence?: "file" | "pending" | "memory";
  spinnerFrame: number;
  taskContentHeight: number;
  maxHeight: number;
}): React.ReactNode {
  const taskRowCount = tasks.length + (taskPersistence === "memory" ? 1 : 0);
  const rows = (
    <TaskRows
      tasks={tasks}
      colors={colors}
      taskPersistence={taskPersistence}
      spinnerFrame={spinnerFrame}
    />
  );

  if (taskRowCount <= MAX_VISIBLE_TASKS) {
    return <box flexDirection="column" width="100%" flexShrink={0}>{rows}</box>;
  }

  return (
    <scrollbox
      height={Math.max(1, taskContentHeight)}
      maxHeight={maxHeight}
      scrollY={true}
      fitContent={true}
      horizontalScrollbarOptions={{ visible: false }}
    >
      {rows}
    </scrollbox>
  );
}

function AgentList({
  agents,
  colors,
  onAgentClick,
  collapsed,
  contentHeight,
  maxHeight,
}: {
  agents: readonly ChildSessionSnapshot[];
  colors: ConversationPalette;
  onAgentClick?: (agentId: string) => void;
  collapsed: boolean;
  contentHeight: number;
  maxHeight: number;
}): React.ReactNode {
  if (collapsed) return null;
  const rows = <AgentRows agents={agents} colors={colors} onAgentClick={onAgentClick} />;
  if (agents.length <= MAX_VISIBLE_AGENTS) {
    return <box flexDirection="column" width="100%" flexShrink={0}>{rows}</box>;
  }
  return (
    <scrollbox
      height={Math.max(1, contentHeight)}
      maxHeight={maxHeight}
      scrollY={true}
      fitContent={true}
      horizontalScrollbarOptions={{ visible: false }}
    >
      {rows}
    </scrollbox>
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
  const runningCount = agents.filter((a) => a.lifecycle === "running" || a.lifecycle === "blocked").length;
  const [spinnerFrame, setSpinnerFrame] = React.useState(0);
  const [tasksCollapsed, setTasksCollapsed] = React.useState(false);
  const [agentsCollapsed, setAgentsCollapsed] = React.useState(false);

  React.useEffect(() => {
    if (tasks.every((task) => task.status !== "in_progress")) {
      setSpinnerFrame(0);
      return undefined;
    }
    const timer = setInterval(() => setSpinnerFrame((frame) => frame + 1), TASK_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tasks]);

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
  const expandedTodoTitle = `● ${tasks.length} tasks (${openTasks.length} open)`;
  const collapsedTodoTitle = `○ ${tasks.length} tasks (${openTasks.length} open)`;
  const todoTitle = tasksCollapsed ? collapsedTodoTitle : expandedTodoTitle;
  const taskContentHeight = taskViewportHeight(tasks.length) + (taskPersistence === "memory" ? 1 : 0);
  const agentContentHeight = agentViewportHeight(agents.length);
  const sharedBodyHeight = statusPanelBodyHeight(
    tasksCollapsed ? 0 : 1 + taskContentHeight,
    agentsCollapsed ? 0 : 1 + agentContentHeight,
    maxHeight,
  );
  const taskTitle = (
    <StatusPanelTitle
      text={todoTitle}
      colors={colors}
      onToggle={() => setTasksCollapsed((collapsed) => !collapsed)}
    />
  );
  const agentsTitle = (
    <StatusPanelTitle
      text={agentTitle}
      colors={colors}
      onToggle={() => setAgentsCollapsed((collapsed) => !collapsed)}
    />
  );

  if (hasAgents && hasTasks) {
    return (
      <box width="100%" flexShrink={0} flexDirection="column" paddingTop={1}>
        <box width="100%" flexShrink={0} height={Math.max(1, sharedBodyHeight)} flexDirection="row" gap={0}>
          <box width="60%" flexShrink={0} flexDirection="column">
            {taskTitle}
            {!tasksCollapsed ? (
              <TaskList
                tasks={tasks}
                colors={colors}
                taskPersistence={taskPersistence}
                spinnerFrame={spinnerFrame}
                taskContentHeight={taskContentHeight}
                maxHeight={maxHeight}
              />
            ) : null}
          </box>
          <box flexGrow={1} flexShrink={0} flexDirection="column">
            {agentsTitle}
            <AgentList
              agents={agents}
              colors={colors}
              onAgentClick={onAgentClick}
              collapsed={agentsCollapsed}
              contentHeight={agentContentHeight}
              maxHeight={maxHeight}
            />
          </box>
        </box>
      </box>
    );
  }

  if (hasAgents) {
    return (
      <box width="100%" flexShrink={0} flexDirection="column" paddingTop={1}>
        {agentsTitle}
        <AgentList
          agents={agents}
          colors={colors}
          onAgentClick={onAgentClick}
          collapsed={agentsCollapsed}
          contentHeight={agentContentHeight}
          maxHeight={maxHeight}
        />
      </box>
    );
  }

  return (
    <box width="100%" flexShrink={0} flexDirection="column" paddingTop={1}>
      {taskTitle}
      {!tasksCollapsed ? (
        <TaskList
          tasks={tasks}
          colors={colors}
          taskPersistence={taskPersistence}
          spinnerFrame={spinnerFrame}
          taskContentHeight={taskContentHeight}
          maxHeight={maxHeight}
        />
      ) : null}
    </box>
  );
}

export const StatusPanel = React.memo(StatusPanelInner);
