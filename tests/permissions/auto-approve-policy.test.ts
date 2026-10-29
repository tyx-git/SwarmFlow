import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PermissionAdvisor,
  PermissionRuleStore,
  type PermissionMode,
} from "../../src/permissions/index.js";
import type { GateDecision } from "../../src/tools/runtime.js";

interface Fixture {
  root: string;
  outsideFile: string;
  store: PermissionRuleStore;
  advisor: PermissionAdvisor;
}

function makeFixture(mode: PermissionMode = "reversible", shellKind: "bash" | "powershell" = "bash"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarmflow-auto-approve-"));
  const outsideDir = resolve(root, "..", `swarmflow-outside-${randomUUID().slice(0, 8)}`);
  const outsideFile = join(outsideDir, "outside.txt");
  const store = new PermissionRuleStore({
    projectStoreDir: join(root, ".swarmflow"),
    workspaceRoot: root,
  });
  const advisor = new PermissionAdvisor({
    ruleStore: store,
    sessionMode: mode,
    projectRoot: root,
    shellKind,
  });
  return { root, outsideFile, store, advisor };
}

function posix(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

async function decide(
  advisor: PermissionAdvisor,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<GateDecision> {
  return advisor.evaluate({
    agentName: "test",
    toolName,
    toolArgs,
    toolCallId: `tc-${randomUUID().slice(0, 8)}`,
    summary: "",
  });
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

describe("auto-approve policy: ordinary commands and workspace writes", () => {
  it.each([
    "npm test",
    "node --version",
    "touch new.txt",
    "rm file.txt",
    "rm -rf build",
    "chmod 755 file.txt",
    "git commit -m done",
    "echo hi > out.txt",
    "cp a b",
    "mv a b",
    "find . -delete",
    "find . -fprint out.txt",
    "tee out.txt",
    "sort -o out.txt a",
    "uniq in out.txt",
    "tree -o out.txt",
    "mkdir build",
    "cat < file.txt",
  ])("allows %s without asking", async (command) => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, "bash", { command, cwd: fixture.root });
      expect(decision.kind, command).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it.each([
    "sudo whoami",
    "systemctl restart nginx",
    "kill 123",
    "git push",
    "bash -c 'rm -rf /'",
    "powershell -Command 'Get-ChildItem'",
    "echo $(date)",
  ])("still asks for %s", async (command) => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, "bash", { command, cwd: fixture.root });
      expect(decision.kind, command).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });
});

describe("auto-approve policy: workspace boundary", () => {
  it.each([
    (fixture: Fixture) => `rm ${posix(fixture.outsideFile)}`,
    (fixture: Fixture) => `touch ${posix(fixture.outsideFile)}`,
    (fixture: Fixture) => `echo hi > ${posix(fixture.outsideFile)}`,
    (fixture: Fixture) => `cp a ${posix(fixture.outsideFile)}`,
    (fixture: Fixture) => `chmod 755 ${posix(fixture.outsideFile)}`,
    () => "rm ../outside.txt",
    () => "find / -delete",
    () => "find . -fprint /tmp/x",
    () => "npm install --prefix /tmp/x",
    () => "tee /tmp/x",
    () => "sort -o /tmp/x a",
    () => "uniq in /tmp/x",
    () => "tree -o /tmp/x",
    () => "mkdir /tmp/x",
    () => "echo hi > $HOME/x",
    () => "echo hi > $(mktemp)",
  ])("asks when a bash write escapes the workspace", async (makeCommand) => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, "bash", {
        command: makeCommand(fixture),
        cwd: fixture.root,
      });
      expect(decision.kind).toBe("ask");
      if (decision.kind === "ask") {
        expect(decision.question).toContain("outside");
      }
    } finally {
      cleanup(fixture);
    }
  });

  it("allows a write target covered by an external-path rule", async () => {
    const fixture = makeFixture();
    try {
      fixture.store.addRule({
        type: "external_path",
        action: "allow",
        accessKind: "write_reversible",
        pathPrefix: posix(dirname(fixture.outsideFile)) + "/",
        scope: "session",
      });
      const touch = await decide(fixture.advisor, "bash", {
        command: `touch ${posix(fixture.outsideFile)}`,
        cwd: fixture.root,
      });
      const remove = await decide(fixture.advisor, "bash", {
        command: `rm ${posix(fixture.outsideFile)}`,
        cwd: fixture.root,
      });
      expect(touch.kind).toBe("allow");
      expect(remove.kind).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it("asks before deleting or chmod-ing the workspace root itself", async () => {
    const fixture = makeFixture();
    try {
      const removeRoot = await decide(fixture.advisor, "bash", { command: "rm -rf .", cwd: fixture.root });
      const chmodRoot = await decide(fixture.advisor, "bash", { command: "chmod 755 .", cwd: fixture.root });
      expect(removeRoot.kind).toBe("ask");
      expect(chmodRoot.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });

  it("asks for file tools outside the workspace", async () => {
    const fixture = makeFixture();
    try {
      const read = await decide(fixture.advisor, "read_file", { path: fixture.outsideFile });
      const write = await decide(fixture.advisor, "write_file", {
        path: fixture.outsideFile,
        content: "x",
      });
      expect(read.kind).toBe("ask");
      expect(write.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });
});

describe("auto-approve policy: scope and modes", () => {
  it("does not auto-approve MCP or unknown tools", async () => {
    const fixture = makeFixture();
    try {
      const mcp = await decide(fixture.advisor, "mcp__demo__deploy", {});
      const unknown = await decide(fixture.advisor, "mystery_tool", {});
      expect(mcp.kind).toBe("ask");
      expect(unknown.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps read_only as a hard cap", async () => {
    const fixture = makeFixture("read_only");
    try {
      const command = await decide(fixture.advisor, "bash", { command: "npm test", cwd: fixture.root });
      const read = await decide(fixture.advisor, "read_file", { path: join(fixture.root, "file.txt") });
      expect(command.kind).toBe("ask");
      expect(read.kind).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it("applies the same workspace boundary to PowerShell file commands", async () => {
    const fixture = makeFixture("reversible", "powershell");
    try {
      const removeInside = await decide(fixture.advisor, "bash", {
        command: "Remove-Item -Recurse -Force ./build",
        cwd: fixture.root,
      });
      const removeOutside = await decide(fixture.advisor, "bash", {
        command: `Remove-Item -Recurse -Force ${posix(fixture.outsideFile)}`,
        cwd: fixture.root,
      });
      const clearInside = await decide(fixture.advisor, "bash", {
        command: "Clear-Content ./out.txt",
        cwd: fixture.root,
      });
      const registryWrite = await decide(fixture.advisor, "bash", {
        command: "Set-Content -Path HKLM:/Software/x -Value 1",
        cwd: fixture.root,
      });
      const setLocation = await decide(fixture.advisor, "bash", {
        command: `Set-Location ${posix(fixture.root)}`,
        cwd: fixture.root,
      });
      expect(removeInside.kind).toBe("allow");
      expect(removeOutside.kind).toBe("ask");
      expect(clearInside.kind).toBe("allow");
      expect(registryWrite.kind).toBe("ask");
      expect(setLocation.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });

  it("lets yolo bypass workspace boundaries but not catastrophic commands", async () => {
    const fixture = makeFixture("yolo");
    try {
      const externalWrite = await decide(fixture.advisor, "bash", {
        command: `touch ${posix(fixture.outsideFile)}`,
        cwd: fixture.root,
      });
      const catastrophic = await decide(fixture.advisor, "bash", {
        command: "rm -rf /",
        cwd: fixture.root,
      });
      expect(externalWrite.kind).toBe("allow");
      expect(catastrophic.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });
});
