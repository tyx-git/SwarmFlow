import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Config } from "../src/config/config.js";
import { loadTemplate, loadTemplates, validateTemplate } from "../src/templates/loader.js";
import { AGENT_ROLE_LABELS, AgentRole } from "../src/swarm/types.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfig(): Config {
  const cfg = new Config({});
  cfg.upsertModelRaw("test-model", {
    provider: "openai",
    model: "gpt-5.2",
    api_key: "dummy-key",
  });
  return cfg;
}

describe("template type validation", () => {
  it("uses only the six canonical built-in role IDs", () => {
    const root = join(process.cwd(), "prompts", "templates");
    const names = readdirSync(root)
      .filter((name) => {
        try {
          return readFileSync(join(root, name, "agent.yaml"), "utf8").length > 0;
        } catch {
          return false;
        }
      })
      .sort();
    expect(names).toEqual(["guard", "merger", "queen", "reviewer", "scout", "worker"]);
    for (const name of names) {
      expect(validateTemplate(join(root, name))).toBeNull();
    }
    expect(AGENT_ROLE_LABELS).toEqual({
      [AgentRole.Queen]: "Queen",
      [AgentRole.Scout]: "Scout",
      [AgentRole.Worker]: "Worker",
      [AgentRole.Reviewer]: "Reviewer",
      [AgentRole.Guard]: "Guard",
      [AgentRole.Merger]: "Merger",
    });
  });

  it("keeps the Queen tool prompt focused on executable tools", () => {
    const toolsPrompt = readFileSync(
      join(process.cwd(), "prompts", "templates", "queen", "tools.md"),
      "utf-8",
    );

    expect(toolsPrompt).not.toContain("`show_context`");
    expect(toolsPrompt).not.toContain("`summarize_context`");
  });

  it("keeps role tool boundaries aligned with the six built-in templates", () => {
    const templates = loadTemplates(
      join(process.cwd(), "prompts", "templates"),
      makeConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      "test-model",
    );
    const names = (role: string) => new Set((templates[role]?.tools ?? []).map((tool) => tool.name));
    expect(names("queen")).not.toContain("write_file");
    expect(names("queen")).not.toContain("bash");
    expect(names("worker")).toContain("write_file");
    expect(names("worker")).toContain("edit_file");
    expect(names("worker")).toContain("bash");
    for (const role of ["scout", "reviewer", "guard", "merger"]) {
      expect(names(role)).not.toContain("write_file");
      expect(names(role)).not.toContain("edit_file");
      expect(names(role)).not.toContain("bash");
    }
  });

  it("keeps the six role prompts explicit about ownership and bounded handoffs", () => {
    const templates = loadTemplates(
      join(process.cwd(), "prompts", "templates"),
      makeConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      "test-model",
    );

    expect(templates.queen?.systemPrompt).toContain("final technical decision");
    expect(templates.queen?.systemPrompt).toContain("Do not edit workspace files");
    expect(templates.scout?.systemPrompt).toContain("read-only investigation agent");
    expect(templates.worker?.systemPrompt).toContain("Never spawn, delegate to, or create another agent");
    expect(templates.reviewer?.systemPrompt).toContain("independent quality reviewer");
    expect(templates.guard?.systemPrompt).toContain("independent safety and recovery reviewer");
    expect(templates.merger?.systemPrompt).toContain("read-only synthesizer");

    for (const role of ["queen", "scout", "reviewer", "guard", "merger"]) {
      expect(templates[role]?.systemPrompt).toContain("Context Boundary");
      expect(templates[role]?.systemPrompt).toContain("swarmflow-handoff");
    }
    expect(templates.worker?.systemPrompt).toContain("swarmflow-handoff");
  });

  it("rejects templates without type: agent", () => {
    const dir = makeTempDir("swarmflow-template-type-missing-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "name: bad-template",
          "system_prompt: hello",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toContain("type: agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects templates with non-agent type", () => {
    const dir = makeTempDir("swarmflow-template-type-invalid-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: worker",
          "name: bad-template",
          "system_prompt: hello",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toMatch(/Invalid template type|无效的模板类型/);
      expect(err).toContain("agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts valid type and can load the template", () => {
    const dir = makeTempDir("swarmflow-template-type-valid-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: good-template",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );

      expect(validateTemplate(dir)).toBeNull();
      const agent = loadTemplate(dir, makeConfig());
      expect(agent.name).toBe("good-template");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses fallbackModel only when a template has no explicit model", () => {
    const dir = makeTempDir("swarmflow-template-fallback-model-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: fallback-template",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );
      const cfg = makeConfig();
      cfg.upsertModelRaw("fallback-model", {
        provider: "deepseek",
        model: "deepseek-chat",
        api_key: "fallback-key",
      });

      const agent = loadTemplate(dir, cfg, undefined, undefined, undefined, "fallback-model");
      expect(agent.modelConfig.name).toBe("fallback-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit template model ahead of fallbackModel", () => {
    const dir = makeTempDir("swarmflow-template-explicit-model-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: explicit-template",
          "model: test-model",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );
      const cfg = makeConfig();
      cfg.upsertModelRaw("fallback-model", {
        provider: "deepseek",
        model: "deepseek-chat",
        api_key: "fallback-key",
      });

      const agent = loadTemplate(dir, cfg, undefined, undefined, undefined, "fallback-model");
      expect(agent.modelConfig.name).toBe("test-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects max_tool_rounds below 100", () => {
    const dir = makeTempDir("swarmflow-template-rounds-low-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: bad-rounds",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 15",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toContain("max_tool_rounds");
      expect(err).toContain(">= 100");
      expect(() => loadTemplate(dir, makeConfig())).toThrow(/max_tool_rounds/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
