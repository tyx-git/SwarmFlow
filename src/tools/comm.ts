/**
 * 通信和编排工具。
 *
 * 以上下文为中心的运行时的工具定义。
 * 详细使用指导在 prompts/templates/queen/system_prompt.md 中。
 * 工具执行器在运行时由 Session 创建。
 */

import type { ToolDef } from "../providers/base.js";

export const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "Queen-only orchestration action: spawn a single sub-agent for a root task already tracked in Queen's task list. Before spawn, bind that root task with task_update by setting owner and metadata.agentId to the chosen child ID; wait for the update to succeed because the child may finish before spawn returns. Child results and unfinished local tasks are linked through metadata.agentId. Child agents cannot spawn or delegate. " +
    "Prefer a predefined template when one matches the task; use template_path only for user-managed custom templates.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique agent ID.",
      },
      template: {
        type: "string",
        description: "Name of a predefined agent template loaded by the runtime.",
      },
      template_path: {
        type: "string",
        description:
          "Path to a user-managed custom template directory. Relative paths resolve against the session artifacts directory.",
      },
      task: {
        type: "string",
        description: "Task description for the agent.",
      },
      mode: {
        type: "string",
        enum: ["oneshot", "persistent"],
        description: "Agent mode: 'oneshot' (single turn) or 'persistent' (stays alive, receives messages via send).",
      },
    },
    required: ["id", "task", "mode"],
  },
  summaryTemplate: "{agent} is spawning sub-agent {id}",
  tuiPolicy: { partialReveal: { completeArgs: ["id"] } },
};

export const KILL_AGENT_TOOL: ToolDef = {
  name: "kill_agent",
  description:
    "Stop one or more running sub-agents by ID. The agent stops mid-work: any file it has not yet written " +
    "stays unwritten, and its in-flight tool calls are cancelled. Its conversation stays on disk: a persistent " +
    "agent can be continued with `send`, while a one-shot agent must be re-dispatched with a new ID. " +
    "`task_resume` only applies to tasks interrupted by a session restart, not to a killed agent. " +
    "Use this when an agent is working on the wrong thing, has gone silent, or the user asks you to stop it — " +
    "not as a routine way to end an agent that is simply slow.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the sub-agents to kill.",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is killing sub-agents",
  tuiPolicy: { partialReveal: "closed" },
};

export const ASK_TOOL: ToolDef = {
  name: "ask",
  description:
    "Ask the user one structured question set when a concrete decision has a small number of alternatives. " +
    "Up to 4 questions per call, up to 4 options each; the user always sees a free-text field, so options are " +
    "suggestions rather than a closed set. Use it to unblock an assumption you cannot resolve from the codebase " +
    "—for example which of two APIs to target, or whether to keep a legacy path. " +
    "Do NOT use it for open-ended exploration, for questions the repository already answers, or to confirm a " +
    "plan the user already stated: ask in plain conversation instead.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array", minItems: 1, maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  summaryTemplate: "{agent} is asking the user a question",
  tuiPolicy: { partialReveal: "closed" },
};

export const CHECK_STATUS_TOOL: ToolDef = {
  name: "check_status",
  description:
    "View sub-agent status and background shell status. " +
    "Returns agent reports (working, completed, errored) and tracked shell summaries.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is checking status",
  tuiPolicy: { partialReveal: "immediate" },
};

/**
 * 阻塞等待运行时事件。
 *
 * 不接受时长参数：阻塞到事件落进 inbox 为止，防卡死上限（2 小时）由
 * Session._execAwaitEvent 的保险丝兜底。历史教训：暴露 seconds 会让模型在
 * 每次超时返回后重新调用一轮 provider，导致同一份计划被反复重发。
 */
export const AWAIT_EVENT_TOOL: ToolDef = {
  name: "await_event",
  description:
    "Block until a runtime event arrives. Events: a child agent completing or failing, an incoming message, " +
    "or a tracked background shell exiting. Takes no arguments. " +
    "Returns immediately when no child agent or tracked shell is running and no message is pending. " +
    "Prefer this over check_status when waiting for child agents or background work.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is awaiting runtime events",
  tuiPolicy: { partialReveal: "immediate" },
};

export const SEND_TOOL: ToolDef = {
  name: "send",
  description:
    "Hand a message to a persistent child agent by ID and return immediately. The child handles it on its next " +
    "activation: expect a confirmation from this call, not a reply. An idle child wakes up to process the " +
    "message; a busy one receives it into its queue. Use it to steer an agent that is already running — " +
    "spawn a new agent when there is no existing one to talk to.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target child agent ID.",
      },
      content: {
        type: "string",
        description: "Message content.",
      },
    },
    required: ["to", "content"],
  },
  summaryTemplate: "{agent} sent message to {to}",
  tuiPolicy: { partialReveal: { completeArgs: ["to"] } },
};
