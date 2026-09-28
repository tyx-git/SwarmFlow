import { existsSync, openSync, writeSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAssistantRenderer,
  getOpenTuiDiagPath,
  isMarkdownPatchDisabled,
  isOpenTuiDiagEnabled,
  resetOpenTuiDiagLog,
  writeOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";
import type { OpenTuiRuntime } from "./bootstrap.js";
import { rotateLogFile } from "../../src/lib/log-rotation.js";
// 必须在任何 renderable 创建之前装上：它给 @opentui/core 预编译产物补上
// FFI 数字参数边界，否则 Yoga 给出 NaN/小数尺寸时会直接抛
// ERR_INVALID_ARG_TYPE，整个 TUI 被 uncaughtException 终结。
import { installFfiBoundsPatch } from "./forked/patch-ffi-bounds.js";
import { installConsoleCleanupHooks, restoreConsoleState } from "./forked/patch-windows-console.js";

interface ParsedArgs {
  templates?: string;
  configOverrides: string[];
  verbose: boolean;
}

const SESSION_CLOSE_TIMEOUT_MS = 4000;

async function prewarmCompiledOpenTuiCore(): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  // Bun --compile mounts bundled JS at a virtual filesystem path:
  // `/$bunfs/root/...` on POSIX, `B:\~BUN\root\...` on Windows. Only run
  // the prewarm in compiled mode — in dev (`bun run dev`) the module
  // graph evaluates in the natural order and the hack would just slow
  // startup. Missing the Windows path form is what allowed the
  // SpanRenderable-extends-TextNodeRenderable TDZ to surface on win32
  // compiled binaries (see Docs/decisions.md D-Windows).
  const isCompiled = thisFile.includes("$bunfs") || /^B:[\\/]~BUN/i.test(thisFile);
  if (!isCompiled) return;

  // Bun's compiled bundler can initialize @opentui/react before async
  // @opentui/core re-exports settle. Import the concrete modules first so
  // React receives initialized renderable constructors from the package barrel.
  await Promise.all([
    import("./forked/core/Renderable.js"),
    import("./forked/core/renderer.js"),
    import("./forked/core/animation/Timeline.js"),
    import("./forked/core/renderables/ASCIIFont.js"),
    import("./forked/core/renderables/Box.js"),
    import("./forked/core/renderables/Code.js"),
    import("./forked/core/renderables/Diff.js"),
    import("./forked/core/renderables/Input.js"),
    import("./forked/core/renderables/LineNumberRenderable.js"),
    import("./forked/core/renderables/Markdown.js"),
    import("./forked/core/renderables/ScrollBox.js"),
    import("./forked/core/renderables/Select.js"),
    import("./forked/core/renderables/TabSelect.js"),
    import("./forked/core/renderables/Text.js"),
    import("./forked/core/renderables/Textarea.js"),
    import("./forked/core/renderables/TextNode.js"),
    import("./forked/core/renderables/TimeToFirstDraw.js"),
  ]);
}

function resolveRendererThreadSetting(): boolean {
  const override = process.env.OPENTUI_USE_THREAD?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;

  // Native render threading has been unstable on macOS in 's
  // high-frequency streaming UI, and the upstream native lib is known to
  // crash with threading on Linux (the fork's renderer defaults it off
  // there). Windows keeps the threaded renderer — the behavior every
  // shipped Windows build has had.
  return process.platform === "win32";
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { configOverrides: [], verbose: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "--templates") {
      parsed.templates = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      if (argv[index + 1]) {
        parsed.configOverrides.push(argv[index + 1]!);
        index += 1;
      }
      continue;
    }
  }

  return parsed;
}

export async function launchTui(): Promise<void> {
  await prewarmCompiledOpenTuiCore();

  const React = await import("react");
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { bootstrapOpenTuiRuntime } = await import("./bootstrap.js");
  const { OpenTuiApp } = await import("./app.js");
  const { parseSettingsOverrides, saveLog } = await import("../../src/config/persistence.js");

  process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  const args = parseArgs(process.argv.slice(2));
  // Validate -c overrides before bootstrap so a bad value fails with aconfig/
  // clean stderr line rather than a fatal stack trace from inside bootstrap.
  try {
    parseSettingsOverrides(args.configOverrides);
  } catch (err) {
    process.stderr.write(`swarmflow: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  // 检测是否为 resume 模式 — 动画已在 cli.ts 中启动，此处只负责清理
  const resumeDir = process.env["SWARMFLOW_RESUME_SESSION_DIR"];
  const resumeAnimCleanup: (() => void) | null = (process as any).__resumeAnimCleanup ?? null;

  if (resumeDir) {
    delete process.env["SWARMFLOW_RESUME_SESSION_DIR"];
  }

  if (isOpenTuiDiagEnabled()) {
    resetOpenTuiDiagLog({
      cwd: process.cwd(),
      diagPath: getOpenTuiDiagPath(),
      platform: process.platform,
      assistantRenderer: getAssistantRenderer(),
      markdownPatchDisabled: isMarkdownPatchDisabled(),
    });
  }

  // 装上 FFI 数字参数边界兜底（必须在 renderer/renderable 创建之前）
  installFfiBoundsPatch();
  // 退出兜底：任何退出路径都要关掉鼠标追踪并清空控制台输入缓冲，
  // 否则退出后鼠标一动就往 shell 里灌 ESC 序列（见 patch-windows-console.ts）。
  installConsoleCleanupHooks();

  // bootstrap 期间 spinner 持续旋转（async，不阻塞事件循环）
  let runtime = await bootstrapOpenTuiRuntime(args);

  // 恢复会话日志
  if (resumeDir) {
    delete process.env["SWARMFLOW_RESUME_SESSION_DIR"];
    const { applySessionRestore } = await import("../../src/session-resume.js");
    const result = applySessionRestore(runtime.session, runtime.store, resumeDir);

    // 恢复完成，停止动画并清屏
    resumeAnimCleanup?.();

    if (!result.ok && result.error) {
      console.error(result.error);
      process.exit(1);
    }
    for (const w of result.warnings) console.warn(w);
  }

  // Redirect stderr to a log file before the TUI takes over the terminal.
  // Without this, console.warn/error from libraries (e.g. markitdown-ts) and
  // MCP server child process stderr corrupt the TUI display.
  const { getSwarmflowHomeDir } = await import("../../src/lib/home-path.js");
  const stderrLogDir = getSwarmflowHomeDir();
  if (!existsSync(stderrLogDir)) mkdirSync(stderrLogDir, { recursive: true });
  const stderrLogPath = join(stderrLogDir, "stderr.log");
  // 用追加而不是 "w" 截断：致命异常的堆栈是唯一的现场证据，被下一次启动
  // 抹掉就没法回溯了。这里同时做一次体积轮转，避免无限增长。
  rotateLogFile(stderrLogPath, 3);
  const stderrLogFd = openSync(stderrLogPath, "a");
  try {
    const separator = Buffer.from(
      `\n===== run ${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))} =====\n`,
      "utf8",
    );
    writeSync(stderrLogFd, separator);
  } catch {
    // best effort
  }
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, typeof encodingOrCb === "string" ? encodingOrCb as BufferEncoding : "utf8") : chunk;
    try { writeSync(stderrLogFd, buf); } catch { /* best effort */ }
    if (typeof encodingOrCb === "function") encodingOrCb();
    else if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;

  const useThread = resolveRendererThreadSetting();
  writeOpenTuiDiag("main.bootstrap", {
    verbose: args.verbose,
    templates: args.templates ?? null,
    useThread,
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    consoleMode: "disabled",
    backgroundColor: "transparent",
    useThread,
  });

  // Resolve effective theme mode BEFORE mounting React so the first frame
  // already uses the correct palette. With a transparent background, rendering
  // the wrong palette on the wrong terminal would be unreadable, so we must
  // never paint contents in an unresolved state.
  const { resolveThemeMode } = await import("./resolve-theme-mode.js");

  // 两次终端查询互相独立：OSC 11 问主题模式，OSC 10 问终端默认前景色
  // （后者用于 auto 模式，让正文颜色匹配用户终端）。渲染器为它们各自
  // 维护独立的等待状态与超时，因此并行发起是安全的，可把最坏的
  // 2×250ms 串行等待压缩为 1×250ms。
  const [resolved, palette] = await Promise.all([
    resolveThemeMode(renderer, runtime.themeModePref),
    // Null on failure/timeout — app.tsx 回退到 token 表中的颜色。
    renderer.getPalette({ timeout: 250 }).catch(() => null),
  ]);
  let currentThemeMode = resolved.mode;
  let currentThemeModePref = resolved.pref;
  let currentTerminalFg: string | null = palette?.defaultForeground ?? null;

  writeOpenTuiDiag("main.theme", {
    pref: resolved.pref,
    mode: resolved.mode,
    source: resolved.source,
    terminalFg: currentTerminalFg,
  });

  const root = createRoot(renderer);
  let exiting = false;
  let fatalCleaningUp = false;

  // Background shells are detached (own process group/session), so nothing
  // implicit reaps them when this process dies — every exit path must kill
  // them explicitly and SYNCHRONOUSLY (signal dispatch needs no await; an
  // un-awaited session.close() never reaches its kill step before
  // process.exit).
  const killShellsSync = () => {
    try {
      runtime.session.killAllShells?.();
    } catch {
      // ignore — exiting anyway
    }
  };

  const cleanupTerminalAfterFatal = (onDone: () => void) => {
    if (fatalCleaningUp) {
      onDone();
      return;
    }
    fatalCleaningUp = true;

    try {
      root.unmount();
    } catch {
      // ignore
    }

    // 与正常退出路径同一套顺序：只调 renderer.destroy() 会把恢复 cooked 模式
    // 之前仍留在内核输入缓冲里的字节（鼠标移动报告等）甩给 shell，表现为
    // 终端退出后仍在源源不断打印乱码，只能关窗。先让终端停止上报，等内核把
    // 在途字节抽上来给 stdinParser 消费掉，再销毁渲染器。
    writeOpenTuiDiag("fatal.enter", {});
    restoreConsoleState();
    try {
      renderer.resetMouseTracking();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        while (process.stdin.read() !== null) {
          // 丢弃残留的输入字节
        }
      } catch {
        // ignore
      }
      try {
        renderer.destroy();
      } catch {
        // ignore
      }
      onDone();
    }, 30);
  };

  const handleFatal = (err: unknown) => {
    writeOpenTuiDiag("main.fatal", {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    killShellsSync();
    cleanupTerminalAfterFatal(() => {
      console.error("Fatal OpenTUI error:", err);
      process.exit(1);
    });
    // 兜底：若上面的回调因异常没跑到，也必须退出，绝不挂死。
    setTimeout(() => process.exit(1), 300).unref?.();
  };

  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);

  // Terminal window close / external kill: reap shells before dying.
  // (Ctrl+C never arrives as SIGINT — the TUI runs in raw mode and handles
  // it as a keypress through the normal exit flow.)
  const handleTermination = () => {
    killShellsSync();
    cleanupTerminalAfterFatal(() => process.exit(0));
  };
  process.on("SIGHUP", handleTermination);
  process.on("SIGTERM", handleTermination);

  let runtimeEpoch = 0;
  let restartingRuntime = false;

  const formatError = (err: unknown): string => {
    return err instanceof Error ? err.message : String(err);
  };

  const saveRuntimeIfNeeded = (target: OpenTuiRuntime): void => {
    const sessionDir = target.store.sessionDir;
    if (!sessionDir || typeof target.session.getLogForPersistence !== "function") return;
    try {
      const { meta, entries } = target.session.getLogForPersistence();
      if (meta.turnCount === 0) return;
      saveLog(sessionDir, meta, [...entries]);
    } catch (err) {
      writeOpenTuiDiag("main.new.save_failed", { error: formatError(err) });
    }
  };

  const closeRuntimeForRestart = async (target: OpenTuiRuntime): Promise<void> => {
    const closePromise = target.session.close();
    const timed = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), SESSION_CLOSE_TIMEOUT_MS);
      }),
    ]).catch((err) => {
      writeOpenTuiDiag("main.new.close_failed", { error: formatError(err) });
      return "failed" as const;
    });

    if (timed === "timeout") {
      writeOpenTuiDiag("main.new.close_timeout", {
        timeoutMs: SESSION_CLOSE_TIMEOUT_MS,
      });
      closePromise.catch((err) => {
        writeOpenTuiDiag("main.new.close_late_failed", { error: formatError(err) });
      });
    }
  };

  const renderRuntime = () => {
    root.render(
      React.createElement(OpenTuiApp, {
        key: `runtime-${runtimeEpoch}`,
        session: runtime.session,
        commandRegistry: runtime.commandRegistry,
        store: runtime.store,
        verbose: runtime.verbose,
        onExit: exit,
        onNewSession: restartRuntime,
        themeMode: currentThemeMode,
        themeModePref: currentThemeModePref,
        terminalDefaultFg: currentTerminalFg,
        diffDisplay: runtime.diffDisplay,
      }),
    );
  };

  const restartRuntime = async () => {
    if (restartingRuntime) return;
    restartingRuntime = true;
    const previousRuntime = runtime;
    writeOpenTuiDiag("main.new.start", { epoch: runtimeEpoch });

    try {
      saveRuntimeIfNeeded(previousRuntime);
      await closeRuntimeForRestart(previousRuntime);
      saveRuntimeIfNeeded(previousRuntime);

      const nextRuntime = await bootstrapOpenTuiRuntime(args);
      const [nextTheme, nextPalette] = await Promise.all([
        resolveThemeMode(renderer, nextRuntime.themeModePref),
        renderer.getPalette({ timeout: 250 }).catch(() => null),
      ]);
      runtime = nextRuntime;
      currentThemeMode = nextTheme.mode;
      currentThemeModePref = nextTheme.pref;
      currentTerminalFg = nextPalette?.defaultForeground ?? null;
      runtimeEpoch += 1;
      writeOpenTuiDiag("main.new.done", {
        epoch: runtimeEpoch,
        themePref: nextTheme.pref,
        themeMode: nextTheme.mode,
        terminalFg: currentTerminalFg,
      });
      // Unmount the previous React tree before re-rendering. `@opentui/react`'s
      // `createRoot.render()` allocates a fresh container on every call instead
      // of reusing the existing one, so without an explicit unmount the old
      // tree is orphaned: its useEffect cleanups never fire, useKeyboard
      // listeners stay registered, and Renderable instances leak. unmount()
      // calls `updateContainer(null, ...)` + `flushSyncWork()` which runs all
      // cleanups synchronously and lets the host config's
      // `detachDeletedInstance` destroy the orphaned Renderable subtree.
      root.unmount();
      renderRuntime();
    } catch (err) {
      const message = formatError(err);
      writeOpenTuiDiag("main.new.failed", { error: message });
      previousRuntime.session.appendErrorMessage?.(
        `Failed to start a new session: ${message}`,
        "command",
      );
    } finally {
      restartingRuntime = false;
    }
  };

  const exit = async (farewell?: string) => {
    if (exiting) return;
    exiting = true;
    writeOpenTuiDiag("main.exit", {
      farewell: farewell ?? null,
    });

    // 1. Restore terminal immediately
    try {
      root.unmount();
    } catch {
      // ignore
    }

    // 1a. Mouse-event residue on exit (three-layer bug, see CHANGELOG and
    // renderer.ts:resetMouseTracking() for the full history).
    //
    // Symptom: after quitting swarmflow on macOS Terminal.app, the shell prompt
    // showed garbage like `51;790;1276M` or `51;65;13M`. These are SGR mouse
    // reports (CSI `<` Cb;Cx;Cy `M`) leaking after destroy — the shell read
    // them as input and printed them.
    //
    // Layer 1 — destroy never wrote ?1000l/?1002l/?1003l/?1006l. Upstream
    // OpenTUI 0.2.1's cleanupBeforeDestroy() simply forgot to reset mouse
    // tracking; modern terminals (iTerm2/Alacritty/Kitty/Ghostty) implicitly
    // clear mouse modes when the alt-screen client exits, so the upstream
    // author never saw the bug. Terminal.app does not clear, so it leaked.
    // opencode (same upstream) shows the same residue with character-cell
    // coordinates because it doesn't enable ?1016.
    //
    // Layer 2 — ?1016 (SGR-Pixels) was added by swarmflow's
    // `feat(tui): sub-cell scrollbar-thumb drag via SGR-Pixels mouse`
    // (b5159a94). That commit added the enable path
    // (`\x1b[?1016h` in updateMousePixelMode) but never paired it with a
    // disable. zig's setMouseMode deliberately ignores ?1016 (see comment
    // in updateMousePixelMode), so even if upstream had reset the other
    // mouse modes, ?1016 would still hang around forcing SGR-Pixel framing
    // on subsequent reports.
    //
    // Layer 3 — even after writing all reset CSIs synchronously here, one or
    // two mouse-motion bytes still leaked. The root cause is the kernel TTY
    // input buffer: while running we're in raw mode and motion reports flow
    // continuously; by the time we write the reset, several bytes are
    // already buffered in the kernel waiting for node to read them.
    // renderer.destroy() restores cooked mode (setRawMode(false)), and any
    // bytes still in the kernel buffer at that moment are inherited by the
    // shell. The fix below is the missing piece: tell the terminal to stop
    // emitting (resetMouseTracking), wait ~30ms so the kernel pumps the
    // in-flight bytes up into node where the still-attached stdinParser
    // consumes them, drain anything left in node's readable queue, then
    // destroy. resetMouseTracking() also bypasses zig's writeOutBuf — an
    // earlier attempt routed ?1000/?1002/?1003/?1006 through
    // lib.disableMouse() but those bytes were dropped when the render
    // thread suspended before draining its buffer.
    //
    // Empirical: 30ms is enough for one kernel pump cycle on macOS even at
    // high mouse motion rates. If residue ever comes back, increasing the
    // window is the first thing to try; the real long-term fix would be a
    // libc tcflush(STDIN_FILENO, TCIFLUSH) via bun:ffi, but that requires
    // platform-specific termios constants.
    // 先用最硬的手段把鼠标模式关掉并清空控制台输入缓冲 —— 这是 renderer
    // 自己那套 reset 之外的必要补充：Windows 上残留在 ConHost 输入缓冲里的
    // 鼠标报告不会被 stdin.read() 抽到，cooked 模式恢复后会被 shell 打印。
    writeOpenTuiDiag("exit.enter", { farewell: !!farewell });
    restoreConsoleState();
    writeOpenTuiDiag("exit.console_restored", {});
    try {
      renderer.resetMouseTracking();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    try {
      while (process.stdin.read() !== null) {
        // discard buffered mouse-event bytes so they don't survive into the shell
      }
    } catch {
      // ignore
    }

    try {
      renderer.destroy();
    } catch {
      // ignore
    }
    writeOpenTuiDiag("exit.renderer_destroyed", {});

    if (farewell) {
      try {
        process.stdout.write(`\n${farewell}\n`);
      } catch {
        console.log(farewell);
      }
    }

    // Resume hint — only if a log was actually written for this session
    // (i.e. the user sent at least one message). New sessions that never
    // got past the prompt don't have a log.json, so there's nothing to resume.
    const sessionDir = runtime.store.sessionDir;
    if (sessionDir && existsSync(join(sessionDir, "log.json"))) {
      try {
        process.stdout.write(`\nTo continue this session, run \nswarmflow --resume ${basename(sessionDir)}\n`);
      } catch {
        // ignore
      }
    }

    // 2. Kill background shells SYNCHRONOUSLY — session.close() below is not
    // awaited (we exit on the next line), and its own kill step sits behind
    // two awaits it never reaches. Signal dispatch is synchronous, so this
    // is the one cleanup that must not ride on the un-awaited close.
    killShellsSync();

    // 3. Best-effort session cleanup, then exit no matter what
    runtime.session.close().catch(() => {});
    process.exit(0);
  };

  renderRuntime();

  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve());
  });

  process.off("uncaughtException", handleFatal);
  process.off("unhandledRejection", handleFatal);
}

// Only auto-invoke when this module is executed directly (e.g. `bun run
// opentui-src/main.tsx`). When it is imported by `src/cli.ts`, the CLI calls
// `launchTui()` itself and we must not start a second instance here.
function isDirectEntry(): boolean {
  // Bun exposes `import.meta.main` for direct-script detection.
  const metaMain = (import.meta as { main?: boolean }).main;
  if (typeof metaMain === "boolean") return metaMain;

  // Node fallback: compare the module URL to process.argv[1].
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const moduleFile = fileURLToPath(import.meta.url);
    const entryFile = resolve(entry);
    try {
      return realpathSync(moduleFile) === realpathSync(entryFile);
    } catch {
      return moduleFile === entryFile;
    }
  } catch {
    return false;
  }
}

export async function runDirectEntry(
  argv: string[] = process.argv,
  launcher: () => Promise<void> = launchTui,
): Promise<void> {
  const { main } = await import("../../src/cli.js");
  await main(argv, { launchTui: launcher });
}

if (isDirectEntry()) {
  runDirectEntry()
    .then(() => process.exit(0))
    .catch((err) => {
      writeOpenTuiDiag("main.catch", {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      console.error("Fatal OpenTUI error:", err);
      process.exit(1);
    });
}
