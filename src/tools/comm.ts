/**
 * 通信和编排工具。
 *
 * 以上下文为中心的运行时的工具定义。
 * 详细使用指导在 prompts/templates/main/system_prompt.md 中。
 * 工具执行器在运行时由 Session 创建。
 */

import type { ToolDef } from "../providers/base.js";

export const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "Spawn a single sub-agent with inline parameters. " +
    "Check pre-defined templates (e.g. 'explorer', 'reviewer') before creating custom ones. " +
    "See system prompt for available templates and their capabilities.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique agent ID.",
      },
      template: {
        type: "string",
        description: "Pre-defined template name, e.g. 'explorer', 'reviewer'.",
      },
      template_path: {
        type: "string",
        description: "Path to a custom template directory relative to {SESSION_ARTIFACTS}.",
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
  description: "Kill one or more running sub-agents by ID.",
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
    "Ask the user 1-4 structured questions with 1-4 options each.",
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

export const AWAIT_EVENT_TOOL: ToolDef = {
  name: "await_event",
  description:
    "Pause this turn until a runtime event arrives or the timeout expires. " +
    "Runtime events include sub-agent completion, incoming messages, and tracked background shell exit. " +
    "Preferred over check_status when you have nothing else to do.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "How long to await runtime events (minimum 15, wall-clock timeout).",
      },
    },
    required: ["seconds"],
  },
  summaryTemplate: "{agent} is awaiting runtime events",
  tuiPolicy: { partialReveal: { completeArgs: ["seconds"] } },
};

export const SEND_TOOL: ToolDef = {
  name: "send",
  description:
    "Send a message to a persistent child agent by ID. " +
    "The message is delivered asynchronously —you get a confirmation, not a reply. " +
    "The target auto-activates if idle.",
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

export const RELOAD_TOOL: ToolDef = {
  name: "reload",
  description:
    "Reload skills, MCP servers, and the system prompt from disk. " +
    "Call after writing or editing SKILL.md files, AGENTS.md, or MCP config (settings.json mcp_servers). " +
    "Returns a summary of what changed.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is reloading configuration",
  tuiPolicy: { partialReveal: "immediate" },
};
