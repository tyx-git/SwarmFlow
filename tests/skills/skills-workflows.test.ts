import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildDefaultRegistry } from "../../src/commands/registration.js";
import { ensureBuiltinSkills, loadSkills } from "../../src/skills/loader.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

describe("skills workflows", () => {
  it("registers the unified entry point and protected workflow commands", () => {
    const registry = buildDefaultRegistry();
    expect(registry.lookup("/skills")?.picker?.mode).toBe("toggle");
    expect(registry.lookup("/skills-creater")).toBeTruthy();
    expect(registry.lookup("/skills-manager")).toBeUndefined();
    expect(registry.lookup("/custom-template")).toBeUndefined();
    expect(registry.lookup("/pptx")).toBeUndefined();
    expect(registry.lookup("/docx")).toBeUndefined();
    expect(registry.lookup("/xlsx")).toBeUndefined();
  });

  it("keeps the full skill description for the width-aware picker layout", () => {
    const registry = buildDefaultRegistry();
    const description = "A skill description that is intentionally much longer than forty characters.";
    const command = registry.lookup("/skills");
    const options = command?.options?.({
      session: {
        getAllSkillNames: () => [{ name: "long-skill", description, enabled: true }],
      },
    });

    expect(options).toHaveLength(1);
    expect(options?.[0]).toMatchObject({
      label: description,
      labelPrefix: "long-skill",
      detailColor: "success",
    });
    expect(options?.[0]?.label.length).toBeGreaterThan(40);
  });

  it("materializes the built-in workflow skills without overwriting user files", () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-skills-home-"));
    try {
      const root = join(home, "skills");
      ensureBuiltinSkills(root);
      const creator = join(root, "skills-creater", "SKILL.md");
      expect(existsSync(creator)).toBe(true);
      expect(readFileSync(creator, "utf8")).toContain("name: skills-creater");
      ensureBuiltinSkills(root);
      const loaded = loadSkills(root);
      expect(loaded.get("skills-creater")?.userInvocable).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks skill changes dirty without rebuilding until reload", () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-dirty-"));
    const harness = makeScriptedSession();
    try {
      const skillDir = join(root, "alpha");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: alpha",
        "description: Alpha skill",
        "---",
        "",
        "Do alpha work.",
      ].join("\n"), "utf-8");

      harness.internals._skillRoots = [root];
      harness.internals._skills = loadSkills(root);
      harness.internals._ensureSkillTool();
      expect(harness.internals._skills.has("alpha")).toBe(true);

      harness.session.setSkillEnabled("alpha", false);
      // 只标记 dirty：当前工具/system 仍是旧前缀。
      expect(harness.internals._skillsDirty).toBe(true);
      expect(harness.internals._skills.has("alpha")).toBe(true);

      const report = harness.session.reloadSkills();
      expect(report.removed).toContain("alpha");
      expect(harness.internals._skillsDirty).toBe(false);
      expect(harness.internals._skills.has("alpha")).toBe(false);
    } finally {
      harness.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies pending skill changes through explicit reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-reload-"));
    const harness = makeScriptedSession();
    try {
      const skillDir = join(root, "beta");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: beta",
        "description: Beta skill",
        "---",
        "",
        "Do beta work.",
      ].join("\n"), "utf-8");

      harness.internals._skillRoots = [root];
      await harness.session.reloadConfigurationFromCommand();
      expect(harness.internals._cachedSystemPrompt).toContain("- beta: Beta skill");

      harness.session.setSkillEnabled("beta", false);
      expect(harness.internals._cachedSystemPrompt).toContain("- beta: Beta skill");

      const report = await harness.session.reloadConfigurationFromCommand();
      expect(report).toContain("Skills:");
      expect(harness.internals._cachedSystemPrompt).not.toContain("- beta: Beta skill");
      expect(harness.internals._skillsDirty).toBe(false);
    } finally {
      harness.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies newly added skills to the current session immediately", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-apply-"));
    const harness = makeScriptedSession();
    try {
      harness.internals._skillRoots = [root];
      const skillDir = join(root, "alpha");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: alpha",
        "description: Alpha skill",
        "---",
        "",
        "Do alpha work.",
      ].join("\n"), "utf-8");

      expect(harness.internals._skills.has("alpha")).toBe(false);
      const report = await harness.session.applySkillsFromCommand();

      expect(report.added).toContain("alpha");
      expect(harness.internals._skills.has("alpha")).toBe(true);
      expect(harness.internals._cachedSystemPrompt).toContain("- alpha: Alpha skill");
      expect(harness.internals._skillsDirty).toBe(false);
    } finally {
      harness.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes and applies from /skills without requiring /reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-command-"));
    const home = mkdtempSync(join(tmpdir(), "swarmflow-skills-home-"));
    const harness = makeScriptedSession();
    try {
      harness.internals._skillRoots = [root];
      const registry = buildDefaultRegistry();
      const messages: string[] = [];
      const ctx: any = {
        session: harness.session,
        showMessage: (message: string) => messages.push(message),
        showHint: (message: string) => messages.push(message),
        commandRegistry: registry,
        autoSave: () => {},
        resetUiState: () => {},
        swarmflowHomeDir: home,
      };
      const command = registry.lookup("/skills");
      expect(command).toBeTruthy();

      const skillDir = join(root, "alpha");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: alpha",
        "description: Alpha skill",
        "---",
        "",
        "Do alpha work.",
      ].join("\n"), "utf-8");

      await command!.handler(ctx, "");

      expect(harness.internals._skills.has("alpha")).toBe(true);
      expect(registry.lookup("/alpha")).toBeTruthy();
      expect(harness.internals._cachedSystemPrompt).toContain("- alpha: Alpha skill");
      expect(harness.session.getAllSkillNames().find((skill) => skill.name === "alpha")?.enabled).toBe(true);
      expect(messages.join("\n")).not.toContain("/reload");

      await command!.handler(ctx, "alpha");

      expect(harness.internals._skills.has("alpha")).toBe(false);
      expect(registry.lookup("/alpha")).toBeUndefined();
      expect(harness.internals._cachedSystemPrompt).not.toContain("- alpha: Alpha skill");
      expect(messages.at(-1)).not.toContain("/reload");
    } finally {
      harness.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("strips BOM from skill names and descriptions", () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-bom-"));
    try {
      const skillDir = join(root, "alpha");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: \uFEFFalpha",
        "description: \uFEFFAlpha skill",
        "---",
        "",
        "Do alpha work.",
      ].join("\n"), "utf-8");

      const loaded = loadSkills(root);
      expect(loaded.get("alpha")?.description).toBe("Alpha skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the system snapshot when startup settings disable a skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-skills-settings-"));
    const harness = makeScriptedSession();
    try {
      const skillDir = join(root, "gamma");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), [
        "---",
        "name: gamma",
        "description: Gamma skill",
        "---",
        "",
        "Do gamma work.",
      ].join("\n"), "utf-8");

      harness.internals._skillRoots = [root];
      await harness.session.reloadConfigurationFromCommand();
      expect(harness.internals._cachedSystemPrompt).toContain("- gamma: Gamma skill");

      harness.session.applySettings({ disabled_skills: ["gamma"] }, {});

      expect(harness.internals._cachedSystemPrompt).not.toContain("- gamma: Gamma skill");
      expect(harness.internals._skills.has("gamma")).toBe(false);
    } finally {
      harness.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
