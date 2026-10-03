import { describe, expect, it } from "vitest";

import { BASIC_TOOLS } from "../src/tools/basic.js";
import {
  ASK_TOOL,
  AWAIT_EVENT_TOOL,
  CHECK_STATUS_TOOL,
  KILL_AGENT_TOOL,
  RELOAD_TOOL,
  SEND_TOOL,
  SPAWN_TOOL,
} from "../src/tools/comm.js";
import { TASK_CONTROL_TOOLS, TASK_TOOLS } from "../src/tools/tasks.js";
import { ensureTaskTools } from "../src/lib/tool-runtime.js";
import { CHILD_SESSION_CAPABILITIES, ROOT_SESSION_CAPABILITIES } from "../src/session-capabilities.js";

const ALL_TASK_TOOLS = [...TASK_TOOLS, ...TASK_CONTROL_TOOLS];

describe("task tool definitions", () => {
  it("uses snake_case names with no collision against builtin or comm tools", () => {
    const existing = new Set([
      ...BASIC_TOOLS.map((t) => t.name),
      SPAWN_TOOL.name,
      KILL_AGENT_TOOL.name,
      ASK_TOOL.name,
      CHECK_STATUS_TOOL.name,
      AWAIT_EVENT_TOOL.name,
      SEND_TOOL.name,
      RELOAD_TOOL.name,
      "skill",
      "$web_search",
    ]);
    const names = ALL_TASK_TOOLS.map((t) => t.name);
    expect(names).toEqual(["task_create", "task_list", "task_get", "task_update", "task_resume"]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(existing.has(name)).toBe(false);
    }
  });

  it("declares the required parameters the executors rely on", () => {
    const byName = new Map(ALL_TASK_TOOLS.map((t) => [t.name, t]));
    expect(byName.get("task_create")?.parameters["required"]).toEqual(["subject", "description"]);
    expect(byName.get("task_list")?.parameters["required"]).toBeUndefined();
    expect(byName.get("task_get")?.parameters["required"]).toEqual(["task_id"]);
    expect(byName.get("task_update")?.parameters["required"]).toEqual(["task_id"]);
    expect(byName.get("task_resume")?.parameters["required"]).toEqual(["task_id"]);
  });

  it("keeps task_update status enum aligned with the store", () => {
    const status = (TASK_TOOLS[3].parameters["properties"] as Record<string, Record<string, unknown>>)["status"];
    expect(status["enum"]).toEqual(["pending", "in_progress", "completed", "deleted"]);
  });

  it("keeps snake_case parameter names (no camelCase leftovers from pi-tasks)", () => {
    const props = (tool: (typeof ALL_TASK_TOOLS)[number]): string[] =>
      Object.keys(tool.parameters["properties"] as Record<string, unknown>);
    expect(props(TASK_TOOLS[3])).toEqual([
      "task_id",
      "status",
      "subject",
      "description",
      "active_form",
      "owner",
      "metadata",
      "add_blocks",
      "add_blocked_by",
    ]);
    expect(props(TASK_TOOLS[0])).toEqual(["subject", "description", "active_form", "metadata"]);
  });

  it("disambiguates the task list from spawn's work assignment and check_status", () => {
    expect(TASK_TOOLS[0].description).toContain("spawn");
    expect(TASK_TOOLS[0].description).toContain("not a task-list entry");
    expect(TASK_TOOLS[1].description).toContain("check_status");
    expect(TASK_TOOLS[3].description).toContain("resumeHint");
    expect(TASK_CONTROL_TOOLS[0].description).toContain("resumable");
    expect(TASK_CONTROL_TOOLS[0].description).toContain("new agent id");
  });
});

describe("ensureTaskTools", () => {
  it("gives the root session every task tool", () => {
    const tools: typeof BASIC_TOOLS = [];
    ensureTaskTools(tools, ROOT_SESSION_CAPABILITIES);
    expect(tools.map((t) => t.name)).toEqual([
      "task_create",
      "task_list",
      "task_get",
      "task_update",
      "task_resume",
    ]);
    // 注册结果必须与工具定义数组完全一致（顺序也一致：面板/prompt 依赖成组出现）
    expect(tools.map((t) => t.name)).toEqual([...TASK_TOOLS, ...TASK_CONTROL_TOOLS].map((t) => t.name));
  });

  it("gives a child session the list tools but no control tools", () => {
    const tools: typeof BASIC_TOOLS = [];
    ensureTaskTools(tools, CHILD_SESSION_CAPABILITIES);
    expect(tools.map((t) => t.name)).toEqual(["task_create", "task_list", "task_get", "task_update"]);
    expect(tools.some((t) => t.name === "task_resume")).toBe(false);
  });

  it("is idempotent and preserves tools already present", () => {
    const tools = [...BASIC_TOOLS];
    const before = tools.length;
    ensureTaskTools(tools, ROOT_SESSION_CAPABILITIES);
    ensureTaskTools(tools, ROOT_SESSION_CAPABILITIES);
    expect(tools).toHaveLength(before + 5);
    expect(tools.slice(0, before).map((t) => t.name)).toEqual(BASIC_TOOLS.map((t) => t.name));
  });

  it("does not append duplicates when a task tool is already registered", () => {
    const tools = [...TASK_TOOLS];
    ensureTaskTools(tools, CHILD_SESSION_CAPABILITIES);
    expect(tools.map((t) => t.name)).toEqual(["task_create", "task_list", "task_get", "task_update"]);
  });
});

describe("task tool drift guards", () => {
  it("classifies every task tool instead of falling through to the default", async () => {
    const { classifyTool } = await import("../src/permissions/classify.js");
    for (const name of ALL_TASK_TOOLS.map((tool) => tool.name)) {
      const assessment = await classifyTool(name, {});
      expect(assessment.permissionClass).not.toBe("write_potent");
      if (name === "task_list" || name === "task_get") {
        expect(assessment.permissionClass).toBe("read");
      } else {
        expect(assessment.permissionClass).toBe("write_reversible");
      }
    }
  });

  it("marks every task tool as interrupt-safe", async () => {
    const { SAFE_INTERRUPT_TOOLS } = await import("../src/session/session-persistence.js");
    for (const name of ALL_TASK_TOOLS.map((tool) => tool.name)) {
      expect(SAFE_INTERRUPT_TOOLS.has(name)).toBe(true);
    }
  });

  it("gives every task tool a display profile (no bare 'Using <name>' rows)", async () => {
    const { getToolProfile } = await import("../external/opentui/presentation/tool-profiles.js");
    for (const name of ALL_TASK_TOOLS.map((tool) => tool.name)) {
      expect(getToolProfile(name).displayName).not.toContain("Using");
    }
  });

  it("keeps the capability split: children get the list tools but no control tools", () => {
    expect(ROOT_SESSION_CAPABILITIES.includeTaskTools).toBe(true);
    expect(ROOT_SESSION_CAPABILITIES.includeTaskControl).toBe(true);
    expect(CHILD_SESSION_CAPABILITIES.includeTaskTools).toBe(true);
    expect(CHILD_SESSION_CAPABILITIES.includeTaskControl).toBe(false);
  });
});
