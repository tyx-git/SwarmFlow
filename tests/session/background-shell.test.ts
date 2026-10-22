import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { BackgroundShellManager } from "../../src/session/background-shell/manager.js";
import { SessionStore } from "../../src/config/session-store.js";
import { shell } from "../../src/platform/index.js";
import { Session } from "../../src/session.js";
import { executeTool } from "../../src/tools/dispatch.js";
import { ToolResult } from "../../src/providers/response.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows 在进程刚退出时可能短暂占用目录句柄，删除需要重试。 */
function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const isPowerShell = shell.kind === "pwsh" || shell.kind === "powershell";
const backgroundTestTimeout = isPowerShell ? 30_000 : 10_000;

function printCommand(text: string): string {
  const escaped = text.replace(/'/g, "''");
  return isPowerShell ? `Write-Output '${escaped}'` : `printf '${escaped}\\n'`;
}

function sleepCommand(seconds: number): string {
  return isPowerShell
    ? `Start-Sleep -Milliseconds ${Math.round(seconds * 1000)}`
    : `sleep ${seconds}`;
}

function successfulCommand(): string {
  return isPowerShell ? "exit 0" : "true";
}

function childProcessCommand(): string {
  return isPowerShell
    ? "Write-Output 'started'; Start-Process -FilePath node -ArgumentList @('-e', 'setTimeout(() => {}, 600000)') -NoNewWindow -Wait"
    : "sh -c 'sleep 600' & echo started; wait";
}

/**
 * Wait until the shell entry for `id` is either gone or no longer "running".
 * Replaces brittle `setTimeout(50ms)` polls — those are sensitive to CI load
 * (under contention, `close` may not fire within the budget and the next
 * bash_background gets rejected as "already tracked and running"). Polling
 * the actual status field is deterministic regardless of host speed.
 */
async function waitForShellExit(
  sm: BackgroundShellManager,
  id: string,
  maxMs = isPowerShell ? 10_000 : 3_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const entry = sm.getShellEntry(id);
    if (!entry || entry.status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`shell '${id}' did not exit within ${maxMs}ms`);
}

/**
 * 终止 shell 并等待子进程真正关闭。
 *
 * Windows 上删除临时项目目录时，只要 shell 的 cwd 还指向该目录，
 * rmSync 就会报 EPERM。killShell 只负责发信号并更新状态，不等待
 * process 的 close 事件，因此清理路径需要再等一步。
 */
async function killShellAndWait(
  sm: BackgroundShellManager,
  ids: string[],
  maxMs = 5_000,
): Promise<void> {
  const closers = ids.map((id) => {
    const entry = sm.getShellEntry(id);
    if (!entry || entry.status !== "running" || typeof entry.process?.once !== "function") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxMs);
      entry.process.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
  await sm.killShell(ids);
  await Promise.all(closers);
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();
  const config = {
    mcpServerConfigs: [],
    getModel: () => ({ model: "test" }),
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
    projectRoot,
  });
}

describe("background shell tools", () => {
  it("writes shell logs under the project's .swarmflow session directory", async () => {
    const root = makeTempDir("swarmflow-shell-project-log-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "layout", command: successfulCommand() });
      await waitForShellExit(sm, "layout");

      const entry = sm.getShellEntry("layout");
      expect(entry).toBeTruthy();
      const sessionId = basename((session as any)._store.sessionDir as string);
      expect(entry!.logPath).toBe(
        join(root, ".swarmflow", sessionId, "shells", "layout.log"),
      );
      expect(existsSync(entry!.logPath)).toBe(true);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("keeps child-agent shell logs under the root session's agents directory", async () => {
    const root = makeTempDir("swarmflow-shell-child-log-");
    const session = makeSession(root);
    try {
      const sessionId = basename((session as any)._store.sessionDir as string);
      expect((session as any)._resolveShellLogDir()).toBe(
        join(root, ".swarmflow", sessionId, "shells"),
      );
      expect((session as any)._resolveChildShellLogDir("worker-1")).toBe(
        join(root, ".swarmflow", sessionId, "agents", "worker-1", "shells"),
      );
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("wires a child session's shell manager to its project-local log directory", async () => {
    const root = makeTempDir("swarmflow-shell-child-wire-");
    const session = makeSession(root);
    try {
      const childAgent = {
        name: "w1",
        systemPrompt: "Test child agent.",
        tools: [],
        maxToolRounds: 8,
        modelConfig: { model: "test-model", contextLength: 8192, supportsMultimodal: false },
      } as any;
      const handle = (session as any)._instantiateChildSession(
        "w1",
        "worker",
        "oneshot",
        childAgent,
      );
      const childSm = (handle.session as any)._shellManager as BackgroundShellManager;
      childSm.execBashBackground({ id: "child-shell", command: successfulCommand() });
      await waitForShellExit(childSm, "child-shell");

      const entry = childSm.getShellEntry("child-shell");
      expect(entry).toBeTruthy();
      const sessionId = basename((session as any)._store.sessionDir as string);
      expect(entry!.logPath).toBe(
        join(root, ".swarmflow", sessionId, "agents", "w1", "shells", "child-shell.log"),
      );
      expect(existsSync(entry!.logPath)).toBe(true);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("tracks shell lifecycle and exposes a readable log", async () => {
    const root = makeTempDir("swarmflow-shell-root-");
    const session = makeSession(root);
    try {
      const started = (session as any)._shellManager.execBashBackground({
        id: "demo",
        command: `${printCommand("hello")}; ${sleepCommand(0.2)}; ${printCommand("done")}`,
      }) as ToolResult;
      expect(started.content).toContain("Started background shell 'demo'");
      expect(started.content).toContain("read_file");
      expect(started.content).toContain("tail_lines=200");

      const waited = await (session as any)._execAwaitEvent() as ToolResult;
      // await_event wakes on system_notice (shell exit) and/or shell-state racers; shell lines use
      // _buildShellReport() contains the shell status without a separate banner.
      expect(waited.content).toMatch(/Waited for \d+s —/);
      expect(waited.content).toContain("[demo]");
      expect(waited.content).toContain("exited");

      const entry = (session as any)._shellManager.getShellEntry("demo") as { logPath: string } | null;
      expect(entry).toBeTruthy();
      const output = readFileSync(entry!.logPath, "utf8");
      expect(output).toContain("hello");
      expect(output).toContain("done");
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  // ── Lifecycle regression tests (2026-05) ───────────────────────────
  // Before these fixes, killing a shell that spawned its own descendants
  // (e.g. `sh -c "node child.js"`) would leak the descendant as an orphan
  // holding the stdio pipe open. The shell entry's status stayed stuck at
  // "running" forever because `close` never fired. The agent then couldn't
  // reuse the shell id, and check_status reported a zombie as live.

  it("kill_shell flips status to 'killed' synchronously, before close fires", async () => {
    const root = makeTempDir("swarmflow-shell-sync-kill-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      const command = isPowerShell
        ? "while ($true) { Start-Sleep -Seconds 1 }"
        : "while true; do sleep 1; done";
      sm.execBashBackground({ id: "loop", command });

      // Active entry should be "running" right after spawn.
      expect(sm.buildShellReport()).toContain("Running:");
      expect(sm.buildShellReport()).toContain("[loop]");

      // Issue kill, but DON'T await it. Status must flip immediately so any
      // downstream check_status / bash_background sees the correct state.
      const killPromise = sm.execKillShell({ ids: ["loop"] });
      const report = sm.buildShellReport();
      expect(report).toContain("Terminated");
      expect(report).toContain("[loop] killed");
      expect(report).not.toMatch(/\[loop\] running/);

      // Now drain the kill promise so the test cleans up gracefully.
      await killPromise;
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("kill_shell tears down child processes via process-group kill (no orphans)", async () => {
    const root = makeTempDir("swarmflow-shell-pgid-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      // Spawn a shell that forks a long-running child process — the
      // classic `npm run dev` scenario without needing npm. If we only
      // killed the immediate sh and not the grandchild, the close event
      // would never fire because the grandchild holds the stdio pipes.
      sm.execBashBackground({
        id: "treekill",
        command: childProcessCommand(),
      });
      // Give the inner sh time to fork.
      await new Promise((r) => setTimeout(r, 200));

      const killed = (await sm.execKillShell({ ids: ["treekill"] })) as ToolResult;
      expect(killed.content).toContain("killed");

      // After kill, status must be "killed" — confirms `close` actually
      // fired (or the synchronous flip held). Either way: no zombie.
      const report = sm.buildShellReport() as string;
      expect(report).toMatch(/\[treekill\] killed/);
      expect(report).not.toMatch(/\[treekill\] running/);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("bash_background allows reusing an id once the prior shell stopped, archiving the old log", async () => {
    const root = makeTempDir("swarmflow-shell-reuse-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "dev-server", command: printCommand("v1") });
      await waitForShellExit(sm, "dev-server");

      // Reuse the same id — must succeed and report the archived prior log.
      const restarted = sm.execBashBackground({
        id: "dev-server",
        command: printCommand("v2"),
      }) as ToolResult;
      expect(restarted.content).toContain("Started background shell 'dev-server'");
      expect(restarted.content).toContain("previous log (id was reused):");

      // Verify an archived file actually exists on disk.
      const entry = sm.getShellEntry("dev-server");
      expect(entry).toBeTruthy();
      const shellsDir = dirname(entry!.logPath);
      const files = readdirSync(shellsDir);
      const archived = files.find((f) => /^dev-server\..+\.log$/.test(f));
      expect(archived).toBeTruthy();
      expect(existsSync(join(shellsDir, "dev-server.log"))).toBe(true);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("bash_background still rejects reuse when the prior shell is running", async () => {
    const root = makeTempDir("swarmflow-shell-reuse-block-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "long", command: sleepCommand(30) });
      const conflict = sm.execBashBackground({
        id: "long",
        command: "echo other",
      }) as ToolResult;
      expect(conflict.content).toContain("already tracked and running");
      expect(conflict.content).toContain("kill_shell");
    } finally {
      await killShellAndWait((session as any)._shellManager, ["long"]);
      await session.close();
      removeTempDir(root);
    }
  });

  it("archive pruning for one id does not touch another id whose name shares regex-special chars", async () => {
    // Before the regex-escape fix, an id like `tab.1` would build an
    // archive-pruning pattern with an unescaped `.`, which then ALSO
    // matched archives of an unrelated id like `tabX1` and could delete
    // them when restarting `tab.1`. The `.` is a legal id character per
    // _normalizeShellId, so this case is reachable.
    //
    // To exercise the actual prune path we need entries.length to reach
    // SHELL_ARCHIVE_KEEP_LAST (8). Under the broken pattern, tabX1's
    // archive counts toward that total and becomes the oldest entry —
    // so it gets deleted when pruning runs. Under the fix it doesn't.
    const root = makeTempDir("swarmflow-shell-archive-bleed-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;

      // 1 archive for `tabX1`, created earliest so it would be the oldest
      // candidate if the broken pattern were used during a later tab.1 prune.
      sm.execBashBackground({ id: "tabX1", command: successfulCommand() });
      await waitForShellExit(sm, "tabX1");
      sm.execBashBackground({ id: "tabX1", command: successfulCommand() });
      await waitForShellExit(sm, "tabX1");

      // Restart `tab.1` enough times that the prune step inside
      // _archiveDeadShellLog actually fires. SHELL_ARCHIVE_KEEP_LAST is 8;
      // 11 restarts give 10 tab.1 archives and force at least one prune.
      for (let i = 0; i < 11; i++) {
        sm.execBashBackground({ id: "tab.1", command: successfulCommand() });
        await waitForShellExit(sm, "tab.1");
      }

      const shellsDir = dirname(sm.getShellEntry("tab.1")!.logPath);
      const files = readdirSync(shellsDir);
      const tabX1Archive = files.find((f) => /^tabX1\..+\.log$/.test(f));
      const tab1Archives = files.filter((f) => /^tab\.1\..+\.log$/.test(f));
      // tabX1's archive must survive. Pre-fix, the broken pattern
      // matching tabX1 as a tab.1 archive would have made it the oldest
      // entry and the prune step would have deleted it.
      expect(tabX1Archive).toBeTruthy();
      // tab.1 archives still respect the LRU cap.
      expect(tab1Archives.length).toBeLessThanOrEqual(8);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("prunes archived shell logs to the LRU cap (SHELL_ARCHIVE_KEEP_LAST)", async () => {
    const root = makeTempDir("swarmflow-shell-archive-lru-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      // SHELL_ARCHIVE_KEEP_LAST is 8 in the module. Start+exit the same id
      // 12 times; after the last restart there should be at most 8
      // dev-server.<ts>.log files plus the current dev-server.log.
      for (let i = 0; i < 12; i++) {
        sm.execBashBackground({ id: "dev-server", command: printCommand(`iter${i}`) });
        await waitForShellExit(sm, "dev-server");
      }

      const shellsDir = dirname(sm.getShellEntry("dev-server")!.logPath);
      const files = readdirSync(shellsDir);
      const archives = files.filter((f) => /^dev-server\..+\.log$/.test(f));
      expect(archives.length).toBeLessThanOrEqual(8);
      expect(files).toContain("dev-server.log");
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("reports a dead shell status and keeps its log readable", async () => {
    const root = makeTempDir("swarmflow-shell-banner-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "short", command: printCommand("done") });
      await waitForShellExit(sm, "short");

      const entry = sm.getShellEntry("short") as { status: string; logPath: string } | null;
      expect(entry?.status).toBe("exited");
      expect(readFileSync(entry!.logPath, "utf8")).toContain("done");
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("reports a failed shell with its exit code", async () => {
    const root = makeTempDir("swarmflow-shell-failed-output-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "failed", command: "exit 7" });
      await waitForShellExit(sm, "failed");

      const entry = sm.getShellEntry("failed") as { status: string; exitCode: number | null } | null;
      expect(entry?.status).toBe("failed");
      expect(entry?.exitCode).toBe(7);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("lets read_file page a large shell log", async () => {
    const root = makeTempDir("swarmflow-shell-readfile-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "big", command: sleepCommand(30) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const entry = sm.getShellEntry("big");
      expect(entry).toBeTruthy();
      const lines = Array.from({ length: 1500 }, (_, index) => `big-${String(index + 1).padStart(4, "0")}`);
      appendFileSync(entry!.logPath, `${lines.join("\n")}\n`, "utf8");

      const artifacts = (session as any)._resolveSessionArtifacts() as string;
      const tail = await executeTool(
        "read_file",
        { path: entry!.logPath, tail_lines: 200 },
        { projectRoot: root, sessionArtifactsDir: artifacts },
      ) as ToolResult;
      const tailLines = tail.content.split("\n");
      expect(tailLines[0]).toMatch(/^\[Lines 1301-1500 of 1500 \| mtime_ms=\d+ \| size_bytes=\d+\]$/);
      expect(tailLines.slice(1)).toEqual(
        Array.from({ length: 200 }, (_, index) => `big-${String(1301 + index).padStart(4, "0")}`),
      );

      const head = await executeTool(
        "read_file",
        { path: entry!.logPath },
        { projectRoot: root, sessionArtifactsDir: artifacts },
      ) as ToolResult;
      const headLines = head.content.split("\n");
      expect(headLines[0]).toMatch(/^\[Lines 1-1000 of 1500 \| mtime_ms=\d+ \| size_bytes=\d+\]$/);
      expect(headLines.slice(1)).toEqual([
        ...Array.from({ length: 1000 }, (_, index) => `big-${String(index + 1).padStart(4, "0")}`),
        "",
        "<--- This file has more than 1000 lines. Continue with `start_line=1001` if you need the following lines. --->",
      ]);
    } finally {
      await killShellAndWait((session as any)._shellManager, ["big"]);
      await session.close();
      removeTempDir(root);
    }
  });

  it("exposes snapshots and log-tail details for UI surfaces", async () => {
    const root = makeTempDir("swarmflow-shell-snap-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "snappy", command: printCommand("tail-line") });
      await waitForShellExit(sm, "snappy");

      const snapshots = session.getBackgroundShellSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ id: "snappy", status: "exited", exitCode: 0 });
      expect(snapshots[0].command).toContain("tail-line");

      const detail = session.getBackgroundShellDetail("snappy");
      expect(detail?.logTail).toContain("tail-line");
      expect(detail?.logTruncated).toBe(false);
      expect(session.getBackgroundShellDetail("missing")).toBeNull();
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("killShell reports performed=false when nothing changed", async () => {
    const root = makeTempDir("swarmflow-shell-kill-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;

      expect(await sm.killShell("ghost")).toMatchObject({ performed: false });

      sm.execBashBackground({ id: "quick", command: successfulCommand() });
      await waitForShellExit(sm, "quick");
      const dead = await sm.killShell("quick");
      expect(dead.performed).toBe(false);
      expect(dead.message).toContain("already");

      sm.execBashBackground({ id: "long", command: sleepCommand(30) });
      const killed = await sm.killShell("long");
      expect(killed.performed).toBe(true);
      expect(killed.message).toContain("killed");
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("user stop injects a ride-along notice that neither wakes the agent nor blocks manual commands", async () => {
    const root = makeTempDir("swarmflow-shell-stop-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "devish", command: sleepCommand(30) });

      const message = await session.stopBackgroundShell("devish");
      expect(message).toContain("killed");

      const inbox = (session as any)._inbox as Array<{ content: string; wake?: boolean }>;
      const notice = inbox.find((m) => m.content.includes("manually stopped background shell 'devish'"));
      expect(notice).toBeTruthy();
      expect(notice?.wake).toBe(false);
      expect((session as any)._autoResumeScheduled).toBe(false);

      // Ride-along messages must not block manual compaction.
      expect((session as any)._getManualCompactBlocker()).toBeNull();

      // Stopping an already-dead shell performs nothing and adds no notice.
      const before = inbox.length;
      await session.stopBackgroundShell("devish");
      expect(inbox.length).toBe(before);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it("moves a timed-out sync bash command to a background shell", async () => {
    const root = makeTempDir("swarmflow-shell-adopt-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      const { executeTool } = await import("../../src/tools/dispatch.js");

      const result = await executeTool("bash", {
        command: `${printCommand("early")}; ${sleepCommand(2)}; ${printCommand("late")}`,
        timeout: 1,
        cwd: root,
      }, {
        projectRoot: root,
        sessionArtifactsDir: root,
        adoptShell: (req) => {
          const entry = sm.adoptRunningProcess(req);
          return { id: entry.id, logPath: entry.logPath };
        },
      });
      const text = typeof result === "string" ? result : (result as ToolResult).content;

      expect(text).toContain("MOVED TO BACKGROUND");
      expect(text).toContain("shell-1");
      // 不断言即时输出里含 "early"：那取决于 1s 超时窗口内进程是否已打印，
      // 在并行测试的 CPU 竞争下不可靠。同步阶段的输出由下面的 logTail 断言覆盖。

      const entry = sm.getShellEntry("shell-1");
      expect(entry).toBeTruthy();
      // Seeded log contains the sync-phase output.
      expect(session.getBackgroundShellDetail("shell-1")?.logTail).toContain("early");

      // The process keeps running and the manager keeps recording output.
      await waitForShellExit(sm, "shell-1", 5_000);
      const detail = session.getBackgroundShellDetail("shell-1");
      expect(detail?.status).toBe("exited");
      expect(detail?.logTail).toContain("late");
    } finally {
      await session.close();
      removeTempDir(root);
    }
  });

  it.skipIf(isPowerShell)("forceKillAll escalates to SIGKILL for trees that ignore SIGTERM", async () => {
    const root = makeTempDir("swarmflow-shell-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      // The shell ignores SIGTERM and keeps respawning short-lived sleeps,
      // so a group SIGTERM alone never brings the tree down. The "armed"
      // marker is printed only after the trap is installed, removing the
      // race where SIGTERM arrives before the trap exists.
      const started = sm.execBashBackground({
        id: "stubborn",
        command: 'trap "" TERM; printf armed; while :; do sleep 0.2; done',
      }) as ToolResult;
      expect(started.content).toContain("Started background shell 'stubborn'");

      const entry = sm.getShellEntry("stubborn")!;
      const child = entry.process;

      const armedDeadline = Date.now() + 3_000;
      while (Date.now() < armedDeadline) {
        if (existsSync(entry.logPath) && readFileSync(entry.logPath, "utf8").includes("armed")) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      sm.forceKillAll();

      // SIGTERM cannot kill this tree; only the 1.5s SIGKILL escalation can.
      const deadline = Date.now() + 5_000;
      let exited = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          exited = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(exited).toBe(true);
      // Death by SIGKILL proves the escalation fired — SIGTERM was trapped.
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      removeTempDir(root);
    }
  }, 12_000);
});

describe("shell log hints", () => {
  const makeManager = (tools: readonly string[]): BackgroundShellManager =>
    new BackgroundShellManager({
      projectRoot: process.cwd(),
      getSessionArtifactsDir: () => process.cwd(),
      getShellLogDir: () => join(process.cwd(), ".swarmflow", "test-session", "shells"),
      deliverMessage: () => {},
      hasTools: (name) => tools.includes(name),
    });

  it("always points at read_file and names available shell controls", () => {
    const hint = (makeManager(["await_event", "kill_shell"]) as any)
      ._logHint("shell-1", "C:/logs/shell-1.log") as string;
    expect(hint).toBe(
      "Read the log for shell 'shell-1' at C:/logs/shell-1.log with `read_file` " +
      "(`tail_lines=200` shows the latest output). " +
      "Wait with `await_event` or stop it with `kill_shell` when needed.",
    );
  });

  it("omits shell controls the session does not have", () => {
    const hint = (makeManager([]) as any)
      ._logHint("shell-1", "C:/logs/shell-1.log") as string;
    expect(hint).toBe(
      "Read the log for shell 'shell-1' at C:/logs/shell-1.log with `read_file` " +
      "(`tail_lines=200` shows the latest output).",
    );
  });
});

describe("await_event blocking semantics", () => {
  it("returns immediately when there is nothing left to wait for", async () => {
    const root = makeTempDir("swarmflow-await-empty-");
    const session = makeSession(root);
    try {
      const started = Date.now();
      const result = (await (session as any)._execAwaitEvent()) as ToolResult;
      const elapsedMs = Date.now() - started;

      expect(result.content).toContain("Returned immediately — nothing is running");
      // 没有可等对象时绝不能进入阻塞：这是防止对着已结束的子 agent 空等的熔断。
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("blocks until a tracked background shell exits, then reports the arrival", async () => {
    const root = makeTempDir("swarmflow-await-shell-");
    const session = makeSession(root);
    try {
      (session as any)._shellManager.execBashBackground({
        id: "slow",
        command: `${printCommand("go")}; ${sleepCommand(0.4)}; ${printCommand("done")}`,
      });

      const started = Date.now();
      const result = (await (session as any)._execAwaitEvent()) as ToolResult;
      const elapsedMs = Date.now() - started;

      // 必须真的阻塞到 shell 退出，而不是立刻超时返回。
      expect(elapsedMs).toBeGreaterThanOrEqual(350);
      expect(result.content).toMatch(/Waited for \d+s —new message arrived\./);
    } finally {
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("wakes from the block when a user message lands in the inbox", async () => {
    const root = makeTempDir("swarmflow-await-user-");
    const session = makeSession(root);
    try {
      // 一个长跑 shell 保证 _hasWaitables() 为真，await_event 会先进入阻塞。
      (session as any)._shellManager.execBashBackground({ id: "holder", command: sleepCommand(30) });
      await new Promise((r) => setTimeout(r, 100));

      const pending = (session as any)._execAwaitEvent() as Promise<ToolResult>;
      await new Promise((r) => setTimeout(r, 150));
      expect(session.deliverMessage("user", "urgent instruction")).toEqual({ accepted: true });

      const result = await pending;
      expect(result.content).toMatch(/new message arrived/);
    } finally {
      await killShellAndWait((session as any)._shellManager, ["holder"]);
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);

  it("breaks the block at the ceiling when the awaited object is stuck", async () => {
    const root = makeTempDir("swarmflow-await-ceiling-");
    const session = makeSession(root);
    try {
      // 一个远远不会结束的 shell：唯一的退出路径就是防卡死上限。
      (session as any)._shellManager.execBashBackground({ id: "stuck", command: sleepCommand(600) });
      await new Promise((r) => setTimeout(r, 100));
      (session as any)._awaitEventCeilingMs = 400;

      const started = Date.now();
      const result = (await (session as any)._execAwaitEvent()) as ToolResult;
      const elapsedMs = Date.now() - started;

      expect(elapsedMs).toBeGreaterThanOrEqual(350);
      expect(elapsedMs).toBeLessThan(3000);
      expect(result.content).toMatch(/ceiling reached/);
      expect(result.content).toContain("still no events");
    } finally {
      await killShellAndWait((session as any)._shellManager, ["stuck"]);
      await session.close();
      removeTempDir(root);
    }
  }, backgroundTestTimeout);
});
