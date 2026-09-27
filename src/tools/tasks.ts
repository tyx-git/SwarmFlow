/**
 * 任务列表工具（snake_case 协议名；展示名对齐 pi-tasks 的 TaskCreate 等，见 tool-profiles）。
 *
 * 工具集划分（设计定稿）：
 *  - `task_create` / `task_list` / `task_get` / `task_update`：**主 agent 与子 agent 都可用**
 *    （子 agent 也需要自己拆分并记录任务；其清单为纯内存，随子会话消亡）
 *  - `task_resume`：**仅主 agent**（重启后按 resumeHint 断点续跑某个子代理；子代理无法派生）
 *  - `task_execute`（未在本批次实现）：仅主 agent，落地时按同一约定加 `includeTaskExecute`
 *  - **不新增** `task_output` / `task_stop`：与既有 `bash_output` / `kill_shell` / `check_status` /
 *    `kill_agent` 语义重叠，保持「一个动作一个名字」；任务与执行体之间是只读关联。
 *
 * 命名去歧义：`spawn` 的必填参数 `task` 表示「交给子代理的一次性工作包」，
 * 与本工具族的「任务清单条目」不是一回事 —— 两者在描述里互相点名。
 */

import type { ToolDef } from "../providers/base.js";

// ------------------------------------------------------------------
// task_create
// ------------------------------------------------------------------

export const TASK_CREATE_TOOL: ToolDef = {
  name: "task_create",
  description:
    "Create a task-list entry to track multi-step work in this session.\n\n" +
    "## When to use\n" +
    "- Work with 3+ distinct steps, or work that needs planning before editing\n" +
    "- The user explicitly asks for a task list, or hands over several tasks at once\n" +
    "- Immediately after receiving new instructions, so requirements are captured before work starts\n" +
    "- After finishing a task, to record follow-up work discovered on the way\n\n" +
    "## When NOT to use\n" +
    "- A single straightforward change, a trivial lookup, or a purely conversational question\n" +
    "- Work you are about to hand to a sub-agent as a one-shot assignment: that is the `spawn`\n" +
    "  tool's `task` argument, not a task-list entry. Use this tool when the user should be able\n" +
    "  to watch progress, or when the work must survive across turns.\n\n" +
    "## Fields\n" +
    "- **subject**: brief actionable title in imperative form (e.g. \"Fix the login redirect\")\n" +
    "- **description**: what must be done, including context and acceptance criteria — enough for\n" +
    "  another agent to pick it up\n" +
    "- **active_form** (optional): present-continuous wording shown while the task is in progress\n" +
    "  (e.g. \"Fixing the login redirect\"); falls back to the subject\n\n" +
    "New tasks start as `pending`. Create several tasks by calling this tool once per task in the\n" +
    "same response — independent calls run in parallel. Check `task_list` first to avoid duplicates.\n" +
    "Use `task_update` afterwards to mark progress or to wire up `add_blocks` / `add_blocked_by`.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "A brief title for the task, in imperative form.",
      },
      description: {
        type: "string",
        description: "What needs to be done, including context and acceptance criteria.",
      },
      active_form: {
        type: "string",
        description:
          "Present-continuous wording shown while the task is in progress (e.g. 'Running tests'). Defaults to the subject.",
      },
      metadata: {
        type: "object",
        description:
          "Arbitrary metadata attached to the task. Keys: agentId (sub-agent executing it), result (its outcome), and similar bookkeeping.",
        additionalProperties: true,
      },
    },
    required: ["subject", "description"],
  },
  summaryTemplate: "{agent} is creating task {subject}",
  tuiPolicy: { partialReveal: { completeArgs: ["subject"] } },
};

// ------------------------------------------------------------------
// task_list
// ------------------------------------------------------------------

export const TASK_LIST_TOOL: ToolDef = {
  name: "task_list",
  description:
    "List the tasks tracked for this session.\n\n" +
    "## When to use\n" +
    "- To see what is available to work on (`pending`, unowned, not blocked)\n" +
    "- To check overall progress, or to find what is blocked on what\n" +
    "- After completing a task, to pick up the next one\n\n" +
    "## Output\n" +
    "One line per task: `#id [status] subject`, plus the owner and any unfinished blockers.\n" +
    "Read it together with `task_get`, which returns the full description and dependency edges.\n\n" +
    "## Reading the status\n" +
    "- `pending` — not started. `pending` with an `interrupted` marker means a previous run was cut\n" +
    "  short: check `resumeHint` on the task before deciding whether to continue or re-dispatch.\n" +
    "- `in_progress` — something is working on it right now (you, or a sub-agent in `owner`).\n" +
    "- `completed` — done. Prefer working on the lowest id first; earlier tasks set up context.\n\n" +
    "This is the **task list**, not runtime agent status — use `check_status` for sub-agent and\n" +
    "background-shell state.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is listing tasks",
  tuiPolicy: { partialReveal: "immediate" },
};

// ------------------------------------------------------------------
// task_get
// ------------------------------------------------------------------

export const TASK_GET_TOOL: ToolDef = {
  name: "task_get",
  description:
    "Retrieve one task by id, including its description, dependency edges and metadata.\n\n" +
    "## When to use\n" +
    "- Before starting work, to read the full requirements instead of only the subject line\n" +
    "- To understand what a task blocks and what blocks it\n" +
    "- After taking over a task that another run left behind, to read its recorded result or error\n\n" +
    "## Tips\n" +
    "- Confirm `blockedBy` has no unfinished entries before you begin.\n" +
    "- Use `task_list` to see all tasks in summary form.",
  parameters: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the task to retrieve (as shown by `task_list`).",
      },
    },
    required: ["task_id"],
  },
  summaryTemplate: "{agent} is reading task {task_id}",
  tuiPolicy: { partialReveal: { completeArgs: ["task_id"] } },
};

// ------------------------------------------------------------------
// task_update
// ------------------------------------------------------------------

export const TASK_UPDATE_TOOL: ToolDef = {
  name: "task_update",
  description:
    "Update a task: status, text fields, owner, metadata, or dependency edges.\n\n" +
    "## Status workflow\n" +
    "`pending` → `in_progress` → `completed`. Use `deleted` to remove a task permanently.\n\n" +
    "**Before starting work:** mark the task `in_progress` first — do not begin while it still reads\n" +
    "`pending`. **After finishing:** mark it `completed`, then call `task_list` for the next task.\n\n" +
    "Only mark a task `completed` when it is fully done and verified. If tests fail, the change is\n" +
    "partial, or an error is unresolved: keep it `in_progress` and create a new task describing what\n" +
    "must be resolved.\n\n" +
    "## Fields\n" +
    "- **status**: `pending` | `in_progress` | `completed` | `deleted`\n" +
    "- **subject** / **description** / **active_form**: revise wording when requirements change\n" +
    "- **owner**: who is executing it (a sub-agent id when you dispatched it)\n" +
    "- **metadata**: shallow merge; set a key to `null` to delete it. Use it to record `agentId`,\n" +
    "  `result`, `lastError`, or to clear a stale `resumeHint` after re-dispatching.\n" +
    "- **add_blocks**: tasks that cannot start until this one completes\n" +
    "- **add_blocked_by**: tasks that must complete before this one can start\n\n" +
    "## Dependencies\n" +
    "Edges are maintained in both directions. Self-dependencies, references to missing tasks and\n" +
    "mutual blocks are reported as warnings in the result — resolve them rather than ignoring them.\n\n" +
    "## Resume bookkeeping\n" +
    "A task left `pending` with `interrupted` and a `resumeHint` after a restart can be continued with\n" +
    "`task_resume`, or re-dispatched with `spawn` using a **new** agent id. Re-dispatching means\n" +
    "setting `metadata.agentId` to the new id, which invalidates the old hint.\n\n" +
    "## Staleness\n" +
    "Read the task with `task_get` before updating it, so you are not acting on a stale view.",
  parameters: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the task to update.",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status. `deleted` removes the task permanently.",
      },
      subject: {
        type: "string",
        description: "New subject for the task.",
      },
      description: {
        type: "string",
        description: "New description for the task.",
      },
      active_form: {
        type: "string",
        description: "Present-continuous wording shown while the task is in progress.",
      },
      owner: {
        type: "string",
        description: "Who is executing the task (sub-agent id when dispatched).",
      },
      metadata: {
        type: "object",
        description: "Keys to merge into the task metadata. Set a key to null to delete it.",
        additionalProperties: true,
      },
      add_blocks: {
        type: "array",
        items: { type: "string" },
        description: "Task ids that cannot start until this task completes.",
      },
      add_blocked_by: {
        type: "array",
        items: { type: "string" },
        description: "Task ids that must complete before this task can start.",
      },
    },
    required: ["task_id"],
  },
  summaryTemplate: "{agent} is updating task {task_id}",
  tuiPolicy: { partialReveal: { completeArgs: ["task_id"] } },
};

// ------------------------------------------------------------------
// task_resume
// ------------------------------------------------------------------

export const TASK_RESUME_TOOL: ToolDef = {
  name: "task_resume",
  description:
    "Continue a task whose sub-agent was interrupted, instead of re-dispatching it from scratch.\n\n" +
    "## When to use\n" +
    "- After a restart, when `task_list` shows a `pending` task carrying `resumeHint.resumable: true`\n" +
    "- The interrupted sub-agent already did real work; its conversation is on disk, so continuing it\n" +
    "  replays that context instead of redoing the work\n" +
    "- The task's `resumeHint.reason` is `too_early`, `failed`, `user_stopped`, or `superseded`:\n" +
    "  do **not** resume — re-dispatch with `spawn` (use a new agent id) or ask the user\n\n" +
    "## What happens\n" +
    "The recorded sub-agent is restarted with its previous conversation and continues from the point it\n" +
    "was cut off. Its last action may have partially applied — the continuation prompt tells it to\n" +
    "re-verify that step before moving on.\n\n" +
    "## Parameters\n" +
    "- **task_id**: the task to continue\n" +
    "- **note** (optional): extra instruction appended to the continuation prompt (for example an\n" +
    "  answer to a question the sub-agent asked before it was interrupted)",
  parameters: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id of the interrupted task to continue.",
      },
      note: {
        type: "string",
        description:
          "Extra instruction for the continued run, appended to the continuation prompt (e.g. the answer to a question the sub-agent asked).",
      },
    },
    required: ["task_id"],
  },
  summaryTemplate: "{agent} is resuming task {task_id}",
  tuiPolicy: { partialReveal: { completeArgs: ["task_id"] } },
};

// ------------------------------------------------------------------
// 导出
// ------------------------------------------------------------------

/** 主 agent 与子 agent 都可用的任务工具。 */
export const TASK_TOOLS: ToolDef[] = [
  TASK_CREATE_TOOL,
  TASK_LIST_TOOL,
  TASK_GET_TOOL,
  TASK_UPDATE_TOOL,
];

/** 仅主 agent 可用的任务工具（子代理不能派生执行体）。 */
export const TASK_CONTROL_TOOLS: ToolDef[] = [TASK_RESUME_TOOL];
