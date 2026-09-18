import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Session } from "../src/session.js";
import { SubAgentFactory } from "../src/session/subagent-factory.js";
import { executeTool } from "../src/tools/basic.js";

function makeTemplateFactory(artifactsDir: string): SubAgentFactory {
  // Template-path resolution only touches resolveSessionArtifacts; the other
  // deps are inert stubs.
  return new SubAgentFactory({
    getAgentTemplates: () => ({}),
    getConfig: () => ({ agentModels: {}, modelTiers: {}, subAgentInheritMcp: false }) as never,
    getMcpManager: () => undefined,
    getPromptsDirs: () => undefined,
    resolveSessionArtifacts: () => artifactsDir,
    getParentModelConfig: () => ({}) as never,
    resolvePinnedModel: () => {
      throw new Error("unused");
    },
    resolveTierModel: () => {
      throw new Error("unused");
    },
    appendStatus: () => {},
  });
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("path security integration", () => {
  it("allows external reads at executor layer and gates external writes by allowlist", async () => {
    const projectRoot = makeTempDir("swarmflow-tool-root-");
    const externalRoot = makeTempDir("swarmflow-tool-ext-");
    try {
      const insideFile = join(projectRoot, "inside.txt");
      writeFileSync(insideFile, "hello\n", "utf-8");

      const insideRead = await executeTool(
        "read_file",
        { path: "inside.txt" },
        { projectRoot },
      );
      expect(insideRead.content).toContain("hello");

      const outsideFile = join(externalRoot, "outside.txt");
      writeFileSync(outsideFile, "outside\n", "utf-8");

      const outsideRead = await executeTool(
        "read_file",
        { path: outsideFile },
        { projectRoot },
      );
      expect(outsideRead.content).toContain("outside");

      const outsideList = await executeTool(
        "list_dir",
        { path: externalRoot },
        { projectRoot },
      );
      expect(outsideList.content).toContain("outside.txt");

      const outsideGrep = await executeTool(
        "grep",
        { pattern: "outside", path: externalRoot },
        { projectRoot },
      );
      expect(outsideGrep.content).toContain("outside.txt");

      const deniedWrites: Array<[string, Record<string, unknown>]> = [
        ["edit_file", { path: outsideFile, edits: [{ old_str: "outside", new_str: "edited" }] }],
        ["write_file", { path: join(externalRoot, "new.txt"), content: "x" }],
      ];

      for (const [toolName, args] of deniedWrites) {
        const result = await executeTool(toolName, args, { projectRoot });
        expect(result.content).toContain("project root boundary");
      }

      const allowedWrite = await executeTool(
        "write_file",
        { path: join(externalRoot, "new.txt"), content: "x" },
        { projectRoot, externalPathAllowlist: [externalRoot] },
      );
      expect(allowedWrite.content).toContain("OK: Wrote");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects spawn with missing template", async () => {
    const fakeSession = Object.create(Session.prototype) as any;
    fakeSession._resolveSessionArtifacts = () => "/tmp/fake";

    const result = await (Session.prototype as any)._execSpawn.call(
      fakeSession,
      { id: "test-agent", task: "do stuff", mode: "oneshot" },
    );
    expect(result.content).toContain("must specify either 'template' or 'template_path'");
  });

  it("rejects spawn with both template and template_path", async () => {
    const fakeSession = Object.create(Session.prototype) as any;
    fakeSession._resolveSessionArtifacts = () => "/tmp/fake";

    const result = await (Session.prototype as any)._execSpawn.call(
      fakeSession,
      { id: "test-agent", template: "explorer", template_path: "custom/", task: "do stuff", mode: "oneshot" },
    );
    expect(result.content).toContain("cannot specify both");
  });

  it("enforces SESSION_ARTIFACTS boundary for template_path (including symlink escapes)", () => {
    const artifactsDir = makeTempDir("swarmflow-template-artifacts-");
    const externalDir = makeTempDir("swarmflow-template-ext-");
    try {
      const validTemplate = join(artifactsDir, "my-template");
      mkdirSync(validTemplate, { recursive: true });
      writeFileSync(
        join(validTemplate, "agent.yaml"),
        "type: agent\nname: test\nsystem_prompt: hello\ntool_tier: read_only\nmax_tool_rounds: 100\n",
        "utf-8",
      );

      const factory = makeTemplateFactory(artifactsDir);

      const resolved = factory.resolveTemplatePath("my-template");
      expect(resolved).toBe(validTemplate);

      expect(() => factory.resolveTemplatePath("../escape")).toThrow(/within SESSION_ARTIFACTS/);

      const linkDir = join(artifactsDir, "linked-template");
      try {
        symlinkSync(externalDir, linkDir, "dir");
      } catch (e: any) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          return;
        }
        throw e;
      }

      mkdirSync(externalDir, { recursive: true });
      writeFileSync(
        join(externalDir, "agent.yaml"),
        "type: agent\nname: ext\nsystem_prompt: hello\ntool_tier: read_only\nmax_tool_rounds: 100\n",
        "utf-8",
      );

      expect(() => factory.resolveTemplatePath("linked-template")).toThrow(/symbolic link/);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
