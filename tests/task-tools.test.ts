import { describe, expect, it } from "vitest";

import { BASIC_TOOLS, KILL_SHELL_TOOL } from "../src/tools/basic.js";
import {
  ASK_TOOL,
  AWAIT_EVENT_TOOL,
  CHECK_STATUS_TOOL,
  KILL_AGENT_TOOL,
  SEND_TOOL,
  SPAWN_TOOL,
} from "../src/tools/comm.js";
import { TASK_CONTROL_TOOLS, TASK_TOOLS } from "../src/tools/tasks.js";
import { ensureCommTools, ensureTaskTools } from "../src/lib/tool-runtime.js";
import type { ToolDef } from "../src/providers/base.js";
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
      // reload 已从模型工具集移除，但 /reload 仍是用户命令名，
      // task_* 若占用该名会与命令撞名，故保留在防重名集合中。
      "reload",
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
      "role",
      "active_form",
      "owner",
      "metadata",
      "add_blocks",
      "add_blocked_by",
    ]);
    expect(props(TASK_TOOLS[0])).toEqual(["subject", "description", "role", "active_form", "metadata"]);
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

describe("comm tool capabilities", () => {
  it("gives the root session await_event and check_status", () => {
    const tools: ToolDef[] = [];
    ensureCommTools(tools, ROOT_SESSION_CAPABILITIES);
    const names = tools.map((t) => t.name);
    expect(names).toContain(AWAIT_EVENT_TOOL.name);
    expect(names).toContain(CHECK_STATUS_TOOL.name);
  });

  it("gives child sessions await_event and kill_shell", () => {
    // Worker 的同步 bash 超时后会得到自己的后台 shell：await_event 等待它退出，
    // kill_shell 负责清理。bash_output 已移除，所有会话读取日志都走 read_file。
    // 该断言锁的是 ensureCommTools 的装配机制，避免 capability 与
    // COMM_TOOL_NAMES 再次脱节。
    expect(CHILD_SESSION_CAPABILITIES.includeAwaitEventTool).toBe(true);
    expect(CHILD_SESSION_CAPABILITIES.includeKillShellTool).toBe(true);
    const tools: ToolDef[] = [];
    ensureCommTools(tools, CHILD_SESSION_CAPABILITIES);
    const names = tools.map((t) => t.name);
    expect(names).toContain(AWAIT_EVENT_TOOL.name);
    expect(names).toContain(KILL_SHELL_TOOL.name);
    expect(names).not.toContain("bash_output");
    expect(names).not.toContain("bash_background");
  });
});

describe("reload is user-only", () => {
  // 两层机制防护（能力位字段已删除，不再参与）：
  //   1. ensureCommTools 的装配逻辑（曾有 if (includeReloadTool) 分支）
  //   2. 工具定义本身（曾导出 RELOAD_TOOL，让执行器注册可被模型触达）
  // 用户链路 /reload 走 reloadConfigurationFromCommand()，不经工具执行器，必须保持可用。

  it("never registers a reload tool for any capability set", () => {
    // 装配函数不得因任何能力配置追加 reload。
    for (const capabilities of [ROOT_SESSION_CAPABILITIES, CHILD_SESSION_CAPABILITIES]) {
      const tools: ToolDef[] = [];
      ensureCommTools(tools, capabilities);
      expect(tools.some((t) => t.name === "reload")).toBe(false);
    }
  });

  it("no longer ships a reload tool definition", async () => {
    // 回归锁：装配逻辑可能被改坏，但工具定义本身也应当消失。
    // 曾有一个 `reload` 工具把 _execReload 暴露给模型，与用户的 /reload 命令
    // 共用同一实现——那让模型能绕过用户确认触发缓存前缀失效。定义已删除，
    // 若这里失败，说明有人把它加回来了。
    const comm = await import("../src/tools/comm.js");
    expect(Object.keys(comm)).not.toContain("RELOAD_TOOL");
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
