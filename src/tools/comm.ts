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
      model_level: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Model tier for this sub-agent. If omitted, the sub-agent inherits the parent model. Tiers must be configured by the user.",
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

export const SHOW_CONTEXT_TOOL: ToolDef = {
  name: "show_context",
  description:
    "Display the context distribution of the current active window. " +
    "Returns a detailed Context Map showing all context groups with their sizes, types, and content previews.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summaryTemplate: "{agent} is inspecting context",
  tuiPolicy: { partialReveal: "immediate" },
};

export const SUMMARIZE_CONTEXT_TOOL: ToolDef = {
  name: "summarize_context",
  description:
    "Summarize a contiguous range of context groups —keep the valuable information, drop the rest. " +
    "Specify the range with `from` and `to` context IDs (inclusive).\n\n" +
    "Rules:\n" +
    "- Never summarize the user's own messages on your own initiative —they anchor turns and must survive.\n" +
    "- Keep each operation within a single turn. For a multi-turn span, submit one operation per turn in a single call —the effect is equivalent.\n" +
    "- Summaries are ordinary context: they may be re-summarized and merged like any other group. When a summary contains <user-message> blocks (the user's original words), carry those blocks verbatim into the new summary.\n\n" +
    "Targets specific ranges. For whole-window summarization, the system uses auto-compact (different mechanism).\n\n" +
    "If you need to inspect the current context distribution first, call show_context.\n\n" +
    "Example —single context group: from=\"a3f1\", to=\"a3f1\"\n" +
    "Example —two non-adjacent groups: use TWO separate operations (one per group), NOT one operation spanning the gap.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Each operation summarizes a contiguous range of context groups into a preserved summary.",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Start context ID of the range (inclusive).",
            },
            to: {
              type: "string",
              description: "End context ID of the range (inclusive). Same as `from` for a single group.",
            },
            content: {
              type: "string",
              description: "Summary content preserving decisions, key facts, file paths, code references, and unresolved issues. Length should match the information density of the original —preserve everything you'd look back at.",
            },
            reason: {
              type: "string",
              description: "Brief reason for summarizing this group.",
            },
          },
          required: ["from", "to", "content"],
        },
      },
    },
    required: ["operations"],
  },
  summaryTemplate: "{agent} is summarizing context",
  tuiPolicy: { partialReveal: "immediate" },
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
