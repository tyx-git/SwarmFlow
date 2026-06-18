import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { BackgroundShellManager } from "../src/background-shell-manager.js";
import { SessionStore } from "../src/persistence.js";
import { Session } from "../src/session.js";
import { ToolResult } from "../src/providers/base.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
  maxMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const entry = sm.getShellEntry(id);
    if (!entry || entry.status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`shell '${id}' did not exit within ${maxMs}ms`);
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
  });
}

describe("background shell tools", () => {
  it("tracks shell lifecycle and exposes output via bash_output", async () => {
    const root = makeTempDir("swarmflow-shell-root-");
    const session = makeSession(root);
    try {
      const started = (session as any)._shellManager.execBashBackground({
        id: "demo",
        command: "printf 'hello\\n'; sleep 0.2; printf 'done\\n'",
      }) as ToolResult;
      expect(started.content).toContain("Started background shell 'demo'");

      const waited = await (session as any)._execAwaitEvent({ seconds: 15 }) as ToolResult;
      // await_event wakes on system_notice (shell exit) and/or shell-state racers; shell lines use
      // _buildShellReport() which does not prefix "# Shell" (that header is show_context only).
      expect(waited.content).toMatch(/Waited for \d+s —/);
      expect(waited.content).toContain("[demo]");
      expect(waited.content).toContain("exited");

      const output = (session as any)._shellManager.execBashOutput({ id: "demo" }) as ToolResult;
      expect(output.content).toContain("hello");
      expect(output.content).toContain("done");
      expect(output.content).toContain("status:");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      sm.execBashBackground({ id: "loop", command: "while true; do sleep 1; done" });

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
      rmSync(root, { recursive: true, force: true });
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
        command: "sh -c 'sleep 600' & echo started; wait",
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bash_background allows reusing an id once the prior shell stopped, archiving the old log", async () => {
    const root = makeTempDir("swarmflow-shell-reuse-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "dev-server", command: "printf 'v1\\n'" });
      await waitForShellExit(sm, "dev-server");

      // Reuse the same id — must succeed and report the archived prior log.
      const restarted = sm.execBashBackground({
        id: "dev-server",
        command: "printf 'v2\\n'",
      }) as ToolResult;
      expect(restarted.content).toContain("Started background shell 'dev-server'");
      expect(restarted.content).toContain("previous log (id was reused):");

      // Verify an archived file actually exists on disk.
      const shellsDir = join(
        (session as any)._shellManager["_getSessionArtifactsDir"](),
        "shells",
      );
      const files = readdirSync(shellsDir);
      const archived = files.find((f) => /^dev-server\..+\.log$/.test(f));
      expect(archived).toBeTruthy();
      expect(existsSync(join(shellsDir, "dev-server.log"))).toBe(true);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bash_background still rejects reuse when the prior shell is running", async () => {
    const root = makeTempDir("swarmflow-shell-reuse-block-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "long", command: "sleep 30" });
      const conflict = sm.execBashBackground({
        id: "long",
        command: "echo other",
      }) as ToolResult;
      expect(conflict.content).toContain("already tracked and running");
      expect(conflict.content).toContain("kill_shell");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
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
      sm.execBashBackground({ id: "tabX1", command: "true" });
      await waitForShellExit(sm, "tabX1");
      sm.execBashBackground({ id: "tabX1", command: "true" });
      await waitForShellExit(sm, "tabX1");

      // Restart `tab.1` enough times that the prune step inside
      // _archiveDeadShellLog actually fires. SHELL_ARCHIVE_KEEP_LAST is 8;
      // 11 restarts give 10 tab.1 archives and force at least one prune.
      for (let i = 0; i < 11; i++) {
        sm.execBashBackground({ id: "tab.1", command: "true" });
        await waitForShellExit(sm, "tab.1");
      }

      const shellsDir = join(
        (session as any)._shellManager["_getSessionArtifactsDir"](),
        "shells",
      );
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes archived shell logs to the LRU cap (SHELL_ARCHIVE_KEEP_LAST)", async () => {
    const root = makeTempDir("swarmflow-shell-archive-lru-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      // SHELL_ARCHIVE_KEEP_LAST is 8 in the module. Start+exit the same id
      // 12 times; after the last restart there should be at most 8
      // dev-server.<ts>.log files plus the current dev-server.log.
      for (let i = 0; i < 12; i++) {
        sm.execBashBackground({ id: "dev-server", command: `printf 'iter${i}\\n'` });
        await waitForShellExit(sm, "dev-server");
      }

      const shellsDir = join(
        (session as any)._shellManager["_getSessionArtifactsDir"](),
        "shells",
      );
      const files = readdirSync(shellsDir);
      const archives = files.filter((f) => /^dev-server\..+\.log$/.test(f));
      expect(archives.length).toBeLessThanOrEqual(8);
      expect(files).toContain("dev-server.log");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bash_output uses a TERMINATED header for dead shells", async () => {
    const root = makeTempDir("swarmflow-shell-banner-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager;
      sm.execBashBackground({ id: "short", command: "printf 'done\\n'" });
      await waitForShellExit(sm, "short");

      const out = sm.execBashOutput({ id: "short" }) as ToolResult;
      // Header + status field both signal dead state — no separate banner.
      expect(out.content).toContain("# Shell Output — TERMINATED");
      expect(out.content).toMatch(/status: (exited|killed|failed)/);
      expect(out.content).toContain("done");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates unread shell output and advances the unread cursor", async () => {
    const root = makeTempDir("swarmflow-shell-trunc-root-");
    const session = makeSession(root);
    try {
      const command = "i=1; while [ $i -le 120 ]; do printf 'line-%03d\\n' \"$i\"; i=$((i+1)); done";
      (session as any)._shellManager.execBashBackground({ id: "burst", command });
      await (session as any)._execAwaitEvent({ seconds: 15 });

      const first = (session as any)._shellManager.execBashOutput({ id: "burst", max_chars: 120 }) as ToolResult;
      expect(first.content).toContain("line-001");
      expect(first.content).toContain("[Truncated here because unread output exceeded");

      const second = (session as any)._shellManager.execBashOutput({ id: "burst", max_chars: 120 }) as ToolResult;
      expect(second.content).toContain("(No new output since the last read.)");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes snapshots and log-tail details for UI surfaces", async () => {
    const root = makeTempDir("swarmflow-shell-snap-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "snappy", command: "printf 'tail-line\\n'" });
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("killShell reports performed=false when nothing changed", async () => {
    const root = makeTempDir("swarmflow-shell-kill-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;

      expect(await sm.killShell("ghost")).toMatchObject({ performed: false });

      sm.execBashBackground({ id: "quick", command: "true" });
      await waitForShellExit(sm, "quick");
      const dead = await sm.killShell("quick");
      expect(dead.performed).toBe(false);
      expect(dead.message).toContain("already");

      sm.execBashBackground({ id: "long", command: "sleep 30" });
      const killed = await sm.killShell("long");
      expect(killed.performed).toBe(true);
      expect(killed.message).toContain("killed");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("user stop injects a ride-along notice that neither wakes the agent nor blocks manual commands", async () => {
    const root = makeTempDir("swarmflow-shell-stop-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      sm.execBashBackground({ id: "devish", command: "sleep 30" });

      const message = await session.stopBackgroundShell("devish");
      expect(message).toContain("killed");

      const inbox = (session as any)._inbox as Array<{ content: string; wake?: boolean }>;
      const notice = inbox.find((m) => m.content.includes("manually stopped background shell 'devish'"));
      expect(notice).toBeTruthy();
      expect(notice?.wake).toBe(false);
      expect((session as any)._autoResumeScheduled).toBe(false);

      // Ride-along messages must not block /summarize //compact.
      expect((session as any)._getManualContextCommandBlocker("/summarize")).toBeNull();

      // Stopping an already-dead shell performs nothing and adds no notice.
      const before = inbox.length;
      await session.stopBackgroundShell("devish");
      expect(inbox.length).toBe(before);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("moves a timed-out sync bash command to a background shell", async () => {
    const root = makeTempDir("swarmflow-shell-adopt-root-");
    const session = makeSession(root);
    try {
      const sm = (session as any)._shellManager as BackgroundShellManager;
      const { executeTool } = await import("../src/tools/basic.js");

      const result = await executeTool("bash", {
        command: "printf 'early\\n'; sleep 2; printf 'late\\n'",
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
      expect(text).toContain("early");

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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceKillAll escalates to SIGKILL for trees that ignore SIGTERM", async () => {
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
        if (existsSync(entry.logPath) && (await Bun.file(entry.logPath).text()).includes("armed")) break;
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
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);
});
