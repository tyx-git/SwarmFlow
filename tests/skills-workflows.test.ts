import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildDefaultRegistry } from "../src/commands/commands.js";
import { ensureBuiltinSkills, loadSkills } from "../src/skills/loader.js";

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
});
