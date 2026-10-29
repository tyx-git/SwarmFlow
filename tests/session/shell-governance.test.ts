import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { shell } from "../../src/platform/index.js";
import { executeTool } from "../../src/tools/dispatch.js";
import { makeSession, makeTempDir } from "./minimal-session.js";

describe("shell governance", () => {
  it("marks a non-zero shell exit as a tool error while preserving the exit code", async () => {
    const root = makeTempDir("swarmflow-p4-bash-exit-proj-");
    try {
      const command = shell.kind === "pwsh" || shell.kind === "powershell"
        ? "exit 7"
        : "exit 7";
      const result = await executeTool(
        "bash",
        { command, timeout: 30 },
        { projectRoot: root },
      );
      expect(result.content).toContain("ERROR: Command exited with code 7");
      expect(result.content).toContain("EXIT CODE: 7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters inherited environment variables for bash tool", async () => {
    const prev = process.env["AGENTFLOW_TEST_SECRET"];
    process.env["AGENTFLOW_TEST_SECRET"] = "super-secret-value";
    try {
      const command = shell.kind === "pwsh" || shell.kind === "powershell"
        ? "Write-Output -NoNewline $env:AGENTFLOW_TEST_SECRET"
        : "printf %s \"$AGENTFLOW_TEST_SECRET\"";
      const result = await executeTool(
        "bash",
        { command, timeout: 30 },
        { projectRoot: process.cwd() },
      );
      expect(result.content).not.toContain("super-secret-value");
      expect(result.content).toContain("EXIT CODE: 0");
    } finally {
      if (prev === undefined) {
        delete process.env["AGENTFLOW_TEST_SECRET"];
      } else {
        process.env["AGENTFLOW_TEST_SECRET"] = prev;
      }
    }
  });

  it("allows external bash cwd at executor layer", async () => {
    const projectRoot = makeTempDir("swarmflow-p4-bash-proj-");
    const externalRoot = makeTempDir("swarmflow-p4-bash-ext-");
    try {
      const result = await executeTool(
        "bash",
        { command: "pwd", cwd: externalRoot, timeout: 30 },
        { projectRoot },
      );
      expect(result.content).toContain("STDOUT:");
      expect(result.content).toContain(externalRoot);
      expect(result.content).toContain("EXIT CODE: 0");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("asks before running bash in an external cwd", async () => {
    const projectRoot = makeTempDir("swarmflow-p4-preflight-proj-");
    const externalRoot = makeTempDir("swarmflow-p4-preflight-ext-");
    try {
      const session = makeSession(projectRoot);

      const preflight = await (session as any)._beforeToolExecute({
        agentName: "Primary",
        toolName: "bash",
        toolArgs: { command: "pwd", cwd: externalRoot },
        toolCallId: "tc1",
        summary: "",
      });
      expect(preflight?.kind).toBe("ask");
      expect(preflight?.ask.summary).toContain("bash in external directory");
      expect(preflight?.ask.options).toEqual(["Allow once", "Deny"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("auto-approves ordinary commands and workspace deletion", async () => {
    const projectRoot = makeTempDir("swarmflow-auto-approve-");
    try {
      const session = makeSession(projectRoot);
      const isPS = shell.kind === "pwsh" || shell.kind === "powershell";
      const preflight = await (session as any)._beforeToolExecute({
        agentName: "Primary",
        toolName: "bash",
        toolArgs: {
          command: isPS
            ? "npm test; Remove-Item -Recurse -Force ./build"
            : "npm test; rm -rf build",
          cwd: projectRoot,
        },
        toolCallId: "tc-auto",
        summary: "",
      });
      expect(preflight).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("asks before writing or deleting outside the workspace", async () => {
    const projectRoot = makeTempDir("swarmflow-boundary-proj-");
    const externalRoot = makeTempDir("swarmflow-boundary-ext-");
    const outsideFile = join(externalRoot, "outside.txt").replace(/\\/g, "/");
    try {
      const session = makeSession(projectRoot);
      const isPS = shell.kind === "pwsh" || shell.kind === "powershell";
      for (const command of [
        isPS ? `Set-Content -Path ${outsideFile} -Value hi` : `echo hi > ${outsideFile}`,
        isPS ? `Remove-Item ${outsideFile}` : `rm ${outsideFile}`,
      ]) {
        const preflight = await (session as any)._beforeToolExecute({
          agentName: "Primary",
          toolName: "bash",
          toolArgs: { command, cwd: projectRoot },
          toolCallId: `tc-${command}`,
          summary: "",
        });
        expect(preflight?.kind, command).toBe("ask");
        expect(preflight?.ask.summary, command).toContain("outside the workspace");
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});
