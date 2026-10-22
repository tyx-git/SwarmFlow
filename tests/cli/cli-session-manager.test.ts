import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";

class FakeTerminalInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    if (enabled) this.emit("raw");
  }

  resume(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }
}

class FakeTerminalOutput {
  isTTY = false;
  columns = 80;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
let activeInput: FakeTerminalInput | null = null;
let activeHomeDir: string | null = null;

function createSession(homeDir: string, id: string, title: string): string {
  const projectDir = join(homeDir, "projects", "project-hash");
  const sessionDir = join(projectDir, id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(projectDir, "project.json"), JSON.stringify({ original_path: "F:/project" }));
  writeFileSync(join(sessionDir, "meta.json"), JSON.stringify({
    created_at: "2026-01-01T00:00:00.000Z",
    last_active_at: "2026-01-01T00:00:00.000Z",
    summary: title,
    title,
    turn_count: 1,
  }));
  return sessionDir;
}

function installFakeTerminal(): { input: FakeTerminalInput; output: FakeTerminalOutput } {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  activeInput = input;
  return { input, output };
}

function restoreTerminal(): void {
  if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
  if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
  activeInput = null;
}

afterEach(() => {
  activeInput?.emit("data", "\x03");
  restoreTerminal();
  if (activeHomeDir) rmSync(activeHomeDir, { recursive: true, force: true });
  activeHomeDir = null;
});

describe("global session manager", () => {
  it("centers the singular title and deletes a focused session after confirmation", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-session-manager-"));
    activeHomeDir = homeDir;
    const deletedId = "22222222-2222-4222-8222-222222222222";
    const keptId = "11111111-1111-4111-8111-111111111111";
    const deletedDir = createSession(homeDir, deletedId, "Delete me");
    createSession(homeDir, keptId, "Keep me");
    const { input, output } = installFakeTerminal();

    let completed = false;
    const manager = main(["node", "swarmflow", "--session"], { homeDir }).finally(() => {
      completed = true;
    });
    await once(input, "raw");
    const plainTitleLine = output.text
      .split("\n")
      .map((line) => line.replace(/\x1B\[[0-9;]*m/g, ""))
      .find((line) => line.includes("[Session]"));
    expect(plainTitleLine, output.text).toBe(`    ${" ".repeat(31)}[Session]`);
    expect(output.text).toContain("d/Delete/Backspace 删除");
    const initialFullRedraws = output.text.match(/\x1B\[2J/g)?.length ?? 0;

    input.emit("data", "\x1B[B");
    expect(output.text.replace(/\x1B\[[0-9;]*m/g, "")).toContain("      ❯ Delete me");
    expect(output.text.match(/\x1B\[2J/g)?.length ?? 0).toBe(initialFullRedraws);

    input.emit("data", "\r");
    expect(output.text).toContain("确定删除会话“Delete me”？按 Enter 再次确认，Esc 取消。");
    expect(output.text.match(/\x1B\[2J/g)?.length ?? 0).toBe(initialFullRedraws);
    input.emit("data", "\r");
    expect(existsSync(deletedDir)).toBe(false);
    expect(existsSync(join(homeDir, "projects", "project-hash", keptId))).toBe(true);
    expect(output.text.match(/\x1B\[2J/g)?.length ?? 0).toBe(initialFullRedraws + 1);
    input.emit("data", "\x03");
    await manager;

    expect(completed).toBe(true);
    expect(output.text).toContain("会话已删除。");
    expect(input.isRaw).toBe(false);
  });

  it("exits on raw Ctrl+C and restores terminal mode", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-session-manager-"));
    activeHomeDir = homeDir;
    createSession(homeDir, "33333333-3333-4333-8333-333333333333", "Session");
    const { input } = installFakeTerminal();

    const manager = main(["node", "swarmflow", "--session"], { homeDir });
    await once(input, "raw");
    input.emit("data", "\x03");
    await manager;

    expect(input.isRaw).toBe(false);
  });
});
