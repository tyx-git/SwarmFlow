import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GLOBAL_MEMORY_FILE,
  SYSTEM_CONTEXT_BUDGET_BYTES,
  assembleFullSystemPrompt,
  ensureGlobalMemoryFile,
  formatSkillsListing,
  truncateUtf8,
} from "../../src/prompts/assembler.js";
import { makeScriptedSession } from "../helpers/session-harness.js";
import { buildDefaultRegistry } from "../../src/commands/registration.js";
import { SPAWN_TOOL } from "../../src/tools/comm.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("system prompt snapshot", () => {
  it("orders role → global memory → project memory → sorted skills", () => {
    const root = makeTempDir("swarmflow-snapshot-project-");
    const home = makeTempDir("swarmflow-snapshot-home-");
    try {
      writeFileSync(join(home, GLOBAL_MEMORY_FILE), "GLOBAL-RULE", "utf-8");
      writeFileSync(join(root, "AGENTS.md"), "PROJECT-RULE", "utf-8");

      const prompt = assembleFullSystemPrompt({
        agentPrompt: "ROLE-BODY",
        projectRoot: root,
        homeDir: home,
        skills: [
          { name: "zeta", description: "last" },
          { name: "alpha", description: "first" },
          { name: "hidden", description: "not model-invocable", disableModelInvocation: true },
        ],
      });

      const roleIdx = prompt.indexOf("ROLE-BODY");
      const globalIdx = prompt.indexOf("# Global Memory (MEMORY.md)");
      const projectIdx = prompt.indexOf("# Persistent Memory (AGENTS.md)");
      const skillsIdx = prompt.indexOf("# Available Skills");
      expect(roleIdx).toBeGreaterThanOrEqual(0);
      expect(globalIdx).toBeGreaterThan(roleIdx);
      expect(projectIdx).toBeGreaterThan(globalIdx);
      expect(skillsIdx).toBeGreaterThan(projectIdx);
      expect(prompt.indexOf("- alpha: first")).toBeLessThan(prompt.indexOf("- zeta: last"));
      expect(prompt).not.toContain("hidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits empty memory and empty skill sections", () => {
    const root = makeTempDir("swarmflow-snapshot-project-");
    const home = makeTempDir("swarmflow-snapshot-home-");
    try {
      const prompt = assembleFullSystemPrompt({
        agentPrompt: "ROLE-BODY",
        projectRoot: root,
        homeDir: home,
        skills: [],
      });
      expect(prompt).toBe("ROLE-BODY");
      expect(prompt).not.toContain("# Global Memory");
      expect(prompt).not.toContain("# Persistent Memory");
      expect(prompt).not.toContain("# Available Skills");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("caps memory and skills while keeping the project layer first", () => {
    const root = makeTempDir("swarmflow-snapshot-project-");
    const home = makeTempDir("swarmflow-snapshot-home-");
    try {
      writeFileSync(join(home, GLOBAL_MEMORY_FILE), "G".repeat(10 * 1024), "utf-8");
      writeFileSync(join(root, "AGENTS.md"), "P".repeat(20 * 1024) + "\nPROJECT-END", "utf-8");
      const skills = Array.from({ length: 20 }, (_, i) => ({
        name: `skill-${String(i).padStart(2, "0")}`,
        description: "S".repeat(2 * 1024),
      }));

      const prompt = assembleFullSystemPrompt({
        agentPrompt: "ROLE",
        projectRoot: root,
        homeDir: home,
        skills,
      });

      expect(prompt).toContain("[truncated]");
      expect(prompt).not.toContain("PROJECT-END");
      expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(SYSTEM_CONTEXT_BUDGET_BYTES);
      // 项目 AGENTS.md 优先级最高，必须完整保留到上限附近。
      expect(prompt.indexOf("P".repeat(1024))).toBeGreaterThan(prompt.indexOf("# Persistent Memory"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the system prompt byte-stable until an explicit reload", () => {
    const harness = makeScriptedSession();
    try {
      const systemBefore = harness.internals._getSystemPrompt() as string;
      writeFileSync(join(harness.projectRoot, "AGENTS.md"), "NEW-PROJECT-RULE", "utf-8");

      const systemAfterFileChange = harness.internals._getSystemPrompt() as string;
      expect(systemAfterFileChange).toBe(systemBefore);
      expect(systemAfterFileChange).not.toContain("NEW-PROJECT-RULE");

      harness.internals._reloadPromptAndTools();
      const systemAfterReload = harness.internals._getSystemPrompt() as string;
      expect(systemAfterReload).toContain("NEW-PROJECT-RULE");
    } finally {
      harness.dispose();
    }
  });

  it("keeps the skill tool definition stable when skills change", () => {
    const harness = makeScriptedSession();
    try {
      const skillToolBefore = harness.session.primaryAgent.tools.find((tool) => tool.name === "skill");
      expect(skillToolBefore).toBeTruthy();
      const beforeJson = JSON.stringify(skillToolBefore);

      // 模拟磁盘上新增 skills 后显式 reload：工具 schema 不包含列表，字节不变。
      harness.internals._skills = new Map([
        ["alpha", { name: "alpha", description: "first", disableModelInvocation: false }],
        ["beta", { name: "beta", description: "second", disableModelInvocation: false }],
      ]);
      harness.internals._ensureSkillTool();
      const skillToolAfter = harness.session.primaryAgent.tools.find((tool) => tool.name === "skill");
      expect(JSON.stringify(skillToolAfter)).toBe(beforeJson);
      expect(skillToolAfter?.description).not.toContain("alpha");
      expect(skillToolAfter?.description).not.toContain("beta");
    } finally {
      harness.dispose();
    }
  });

  it("lists model-invocable skills only, sorted by name", () => {
    const listing = formatSkillsListing([
      { name: "zeta", description: "z" },
      { name: "alpha", description: "a" },
      { name: "hidden", description: "h", disableModelInvocation: true },
    ]);
    expect(listing).toContain("- alpha: a");
    expect(listing).toContain("- zeta: z");
    expect(listing.indexOf("- alpha: a")).toBeLessThan(listing.indexOf("- zeta: z"));
    expect(listing).not.toContain("hidden");
  });

  it("initializes an empty global MEMORY.md without overwriting it", () => {
    const home = makeTempDir("swarmflow-memory-home-");
    try {
      ensureGlobalMemoryFile(home);
      const path = join(home, GLOBAL_MEMORY_FILE);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("");

      writeFileSync(path, "USER-MEMORY", "utf-8");
      ensureGlobalMemoryFile(home);
      expect(readFileSync(path, "utf-8")).toBe("USER-MEMORY");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("truncates on code-point boundaries", () => {
    const text = "a😀b";
    const truncated = truncateUtf8(text, 6);
    expect(truncated).not.toContain("\uFFFD");
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(6);
  });

  it("keeps the spawn tool schema free of a hardcoded template catalog", () => {
    const serialized = JSON.stringify(SPAWN_TOOL);
    expect(serialized).not.toContain("scout");
    expect(serialized).not.toContain("worker");
    expect(serialized).not.toContain("reviewer");
    expect(SPAWN_TOOL.description).toContain("user-managed custom templates");
    expect(SPAWN_TOOL.parameters).toBeTruthy();
  });

  it("no longer registers /rules but exposes explicit /reload", () => {
    const registry = buildDefaultRegistry();
    expect(registry.lookup("/rules")).toBeUndefined();
    expect(registry.lookup("/reload")).toBeTruthy();
  });
});
