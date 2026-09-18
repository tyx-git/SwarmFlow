/**
 * 后台 shell 生命周期管理器。
 *
 * 拥有生成、跟踪、读取输出和终止
 * 后台 shell 进程。从 Session 中提取以保持
 * 主文件更小且责任边界清晰。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";

import { ToolResult } from "../providers/base.js";
import { SafePathError, safePath } from "../security/path.js";
import { shell } from "../platform/index.js";
import {
  argOptionalInteger,
  argOptionalString,
  argRequiredString,
  argRequiredStringArray,
  toolArgError,
} from "../tools/arg-helpers.js";
import type { MessageEnvelope } from "../session-tree-types.js";

// ── 类型 ────────────────────────────────────────────────────────────

export interface BackgroundShellEntry {
  id: string;
  process: ChildProcess;
  command: string;
  cwd: string;
  logPath: string;
  startTime: number;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  readOffset: number;
  recentOutput: string[];
  explicitKill: boolean;
}

/* UI 界面（徽章、选择器、细节选项卡）使用的跟踪 shell 只读视图。 */
export interface BackgroundShellSnapshot {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  /* shell 启动后的秒数。 */
  elapsedSeconds: number;
  /* 最近几行输出（已修剪，最新）。 */
  recentOutput: string[];
  logPath: string;
}

/* shell 详细视图的快照 + 日志尾部。 */
export interface BackgroundShellDetail extends BackgroundShellSnapshot {
  /* 日志文件的尾部（不超过请求的大小）。 */
  logTail: string;
  /* 当日志长度超过尾部窗口时为 true。 */
  logTruncated: boolean;
}

export interface BackgroundShellManagerDeps {
  projectRoot: string;
  getSessionArtifactsDir: () => string;
  deliverMessage: (msg: MessageEnvelope) => void;
}

// 每个 id 保留归档 shell 日志。当模型杀死一个 shell 后用相同 id
// 启动新 shell 时，旧日志会被重命名；这里只保留最近 N 个重命名，
// 避免长会话中的目录无限增长。
//
// 选择 8 的理由：典型开发服务器重启前会写入约 200 KB；
// 8 × 200 KB ≈ 每个 id 最大 1.6 MB。这里镜像 src/tools/basic.ts 中
// BASH_SPILL_KEEP_LAST = 32 的保留惯例；若真实使用超过此范围再调整。

const SHELL_ARCHIVE_KEEP_LAST = 8;

// 将用户输入（这里是 shell id）插入 RegExp 源字符串时需要转义的正则特殊字符。

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

// ── 管理器 ──────────────────────────────────────────────────────────

export class BackgroundShellManager {
  private _activeShells = new Map<string, BackgroundShellEntry>();
  private _shellCounter = 0;

  private readonly _projectRoot: string;
  private readonly _getSessionArtifactsDir: () => string;
  private readonly _deliverMessage: (msg: MessageEnvelope) => void;

  constructor(deps: BackgroundShellManagerDeps) {
    this._projectRoot = deps.projectRoot;
    this._getSessionArtifactsDir = deps.getSessionArtifactsDir;
    this._deliverMessage = deps.deliverMessage;
  }

  // ── 公共查询 ─────────────────────────────────────────────────

  hasTrackedShells(): boolean {
    return this._activeShells.size > 0;
  }

  hasRunningShells(): boolean {
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") return true;
    }
    return false;
  }

  /**
   * `id` 的跟踪条目的只读快照。当 id 未被跟踪时返回 null。
   * 当你需要查看 shell 的状态/日志路径而不触碰私有映射时，
   * 从管理器外部（UI、测试）使用此方法。返回的对象绝对不能被修改 — 视为结构化读取。
   */
  getShellEntry(id: string): Readonly<BackgroundShellEntry> | null {
    return this._activeShells.get(id) ?? null;
  }

  /* 所有跟踪 shell 的快照：运行中的优先，然后按开始时间排序（最新优先）。 */
  listShells(): BackgroundShellSnapshot[] {
    const snapshots = [...this._activeShells.values()].map((entry) => this._snapshotEntry(entry));
    return snapshots.sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return a.elapsedSeconds - b.elapsedSeconds;
    });
  }

  /* 详细视图使用的快照 + 日志尾部。未知 id 返回 null。 */
  getShellDetail(id: string, opts?: { maxChars?: number }): BackgroundShellDetail | null {
    const entry = this._activeShells.get(id);
    if (!entry) return null;
    const maxChars = Math.max(500, Math.min(200_000, opts?.maxChars ?? 16_000));
    let logTail = "";
    let logTruncated = false;
    try {
      if (existsSync(entry.logPath)) {
        const full = readFileSync(entry.logPath, "utf-8");
        logTruncated = full.length > maxChars;
        logTail = logTruncated ? full.slice(-maxChars) : full;
      }
    } catch { /* 日志不可读时返回空尾部 */ }
    return { ...this._snapshotEntry(entry), logTail, logTruncated };
  }

  private _snapshotEntry(entry: BackgroundShellEntry): BackgroundShellSnapshot {
    return {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      elapsedSeconds: (performance.now() - entry.startTime) / 1000,
      recentOutput: [...entry.recentOutput],
      logPath: entry.logPath,
    };
  }

  buildShellReport(): string {
    if (this._activeShells.size === 0) {
      return "No shells tracked.";
    }

    const renderEntry = (id: string, entry: BackgroundShellEntry): string => {
      const elapsedSec = ((performance.now() - entry.startTime) / 1000).toFixed(1);
      let line = `- [${id}] ${entry.status} (${elapsedSec}s)`;
      if (entry.status === "exited" || entry.status === "failed") {
        line += ` | exit=${entry.exitCode ?? "?"}`;
      } else if (entry.status === "killed") {
        line += ` | signal=${entry.signal ?? "TERM"}`;
      }
      line += ` | log: ${entry.logPath}`;
      if (entry.recentOutput.length > 0) {
        line += `\n    recent: ${entry.recentOutput.join(" → ")}`;
      }
      return line;
    };

    // 分为 running 和 terminated，避免模型把已死亡 shell 的过时条目
    // 误认为仍在运行。已终止条目仍然有用（日志仍可读），
    // 但它们不会继续产生新输出。

    const running: string[] = [];
    const terminated: string[] = [];
    for (const [id, entry] of this._activeShells) {
      if (entry.status === "running") {
        running.push(renderEntry(id, entry));
      } else {
        terminated.push(renderEntry(id, entry));
      }
    }

    const out: string[] = [];
    if (running.length > 0) {
      out.push("Running:");
      out.push(...running);
    }
    if (terminated.length > 0) {
      if (out.length > 0) out.push("");
      out.push(
        "Terminated (process is gone; logs above remain readable but no new output will arrive):",
      );
      out.push(...terminated);
    }
    return out.join("\n");
  }

  /**
   * 对所有跟踪的 shell 尽力发送 SIGTERM 并清空状态。
   * 同时重置 shell 计数器。
   */
  forceKillAll(): void {
    const KILL_ESCALATE_MS = 1_500;
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") {
        entry.explicitKill = true;
        entry.status = "killed";
        entry.signal = "SIGTERM";
        BackgroundShellManager._killGroup(entry, "SIGTERM");
        // 像 killShell 一样升级：忽略 SIGTERM 的进程
        // 否则会作为孤儿生存（`close` 仅在整个进程树
        // 释放 stdio 管道后才触发 — 如果尚未
        // 在截止日期前触发，组中仍有进程存活）。
        // 在 Windows 上 killTree 已经是无条件强制杀死，所以
        // 升级发现进程组已消失并返回。计时器
        // 是 unref'd：在进程退出路径上这保持尽力而为
        // 而不是延迟关闭。
        // Mock ChildProcess 对象（测试中采用的 shell）可能缺少
        // `.once` — 与 killTree 的 pid 回退相同的兼容性说明。
        let closed = false;
        if (typeof entry.process?.once === "function") {
          entry.process.once("close", () => {
            closed = true;
          });
        }
        const timer = setTimeout(() => {
          if (!closed) BackgroundShellManager._killGroup(entry, "SIGKILL");
        }, KILL_ESCALATE_MS);
        timer.unref?.();
      }
    }
    this._activeShells.clear();
  }

  // ── 杀死辅助函数 ───────────────────────────────────────────────────

  /**
   * 向由子 shell 领导的整个进程组发送 `sig`。如果组杀死失败
   *（例如在没有进程组的平台上），则回退到仅杀死直接子进程。
   * 如果通过任一路径成功发送信号则返回 true。
   *
   * 为什么这很重要：`npm run dev` 是 `sh -lc "npm run dev"`，它 fork
   * `npm` 再 fork `node`/`vite`。仅杀死 sh 会让 npm 和 vite
   * 成为持有 stdout 管道的孤儿 — 父进程永远看不到
   * "close"，且 `entry.status` 会卡在 "running"。
   * 杀死进程组（sh + npm + vite + workers）会终止整棵树。
   */
  private static _killGroup(
    entry: BackgroundShellEntry,
    sig: NodeJS.Signals,
  ): boolean {
    // 进程组语义位于 shell 提供者中，这样
    // POSIX `process.kill(-pid, sig)` 路径不会泄漏到业务
    // 代码中。当组调用失败时，提供者回退到仅杀死 leader。

    try {
      shell.killTree(entry.process, sig);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 将已死亡 shell 的日志移开，以便新的 shell 可以重用该 id。
   * 成功时返回归档路径，如果没有日志可移动则返回 null。
   *
   * 为此 id 保留最后 `SHELL_ARCHIVE_KEEP_LAST` 个归档日志并删除更早的。
   * 否则，长时间会话中反复重启 `dev-server` 会在 shells 目录中
   * 积累数十个多 MB 的日志文件。
   */
  private _archiveDeadShellLog(entry: BackgroundShellEntry): string | null {
    if (!existsSync(entry.logPath)) return null;

    const dir = dirname(entry.logPath);
    const idName = basename(entry.logPath, ".log");

    // ISO 时间戳 + 短 uuid 后缀，这样在同一毫秒内创建的两个归档
    // 不会在重命名时冲突。
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    const uniq = randomUUID().slice(0, 4);
    const archived = join(dir, `${idName}.${ts}.${uniq}.log`);

    // 修剪此 id 的旧归档（其他 id 的归档不受影响）。
    // 尽力而为：此处的任何错误都被忽略，所以不会阻止重命名。
    try {
      const escapedId = idName.replace(REGEX_SPECIAL_CHARS, "\\$&");
      const archivePattern = new RegExp(`^${escapedId}\\..+\\.log$`);
      const entries = readdirSync(dir)
        .filter((name) => archivePattern.test(name))
        .map((name) => {
          const p = join(dir, name);
          try { return { p, mtime: statSync(p).mtimeMs }; }
          catch { return null; }
        })
        .filter((e): e is { p: string; mtime: number } => e !== null)
        .sort((a, b) => a.mtime - b.mtime);
      while (entries.length >= SHELL_ARCHIVE_KEEP_LAST) {
        const oldest = entries.shift();
        if (!oldest) break;
        try { unlinkSync(oldest.p); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略修剪失败 */ }

    try {
      renameSync(entry.logPath, archived);
      return archived;
    } catch {
      return null;
    }
  }

  /**
   * 重置 shell 计数器（清除瞬态时调用）。
   */
  resetCounter(): void {
    this._shellCounter = 0;
  }

  // ── 工具执行器 ─────────────────────────────────────────────────

  execBashBackground(args: Record<string, unknown>): ToolResult {
    const commandArg = argRequiredString("bash_background", args, "command", { nonEmpty: true });
    if (commandArg instanceof ToolResult) return commandArg;
    const cwdArg = argOptionalString("bash_background", args, "cwd");
    if (cwdArg instanceof ToolResult) return cwdArg;
    const idArg = argOptionalString("bash_background", args, "id");
    if (idArg instanceof ToolResult) return idArg;

    const shellId = idArg
      ? this._normalizeShellId(idArg)
      : `shell-${++this._shellCounter}`;
    if (!shellId) {
      return toolArgError("bash_background", "'id' must contain only letters, numbers, '.', '_' or '-'.");
    }
    // 允许同一 id 的先前 shell 停止运行后重用该 id。常见情况：
    // 模型杀死开发服务器后，想用相同的易记 id（"dev-server"）重启。
    // 归档先前日志，以便新的 shell 可以写入新文件。
    const existing = this._activeShells.get(shellId);
    let archivedLogPath: string | null = null;
    if (existing) {
      if (existing.status === "running") {
        return new ToolResult({
          content:
            `Error: shell '${shellId}' is already tracked and running. ` +
            `Kill it first with kill_shell, or pass a different id.`,
        });
      }
      archivedLogPath = this._archiveDeadShellLog(existing);
      this._activeShells.delete(shellId);
    }

    const cwd = this._resolveShellCwd("bash_background", cwdArg);
    if (cwd instanceof ToolResult) return cwd;

    const logPath = join(this._getShellsDir(), `${shellId}.log`);
    writeFileSync(logPath, "", "utf-8");

    let child: ChildProcess;
    try {
      // Shell 选择、环境过滤和进程组设置位于 src/platform/shell。
      // 这里以非登录方式生成：PATH 已从父进程转发，而每次生成都 source
      // 完整登录配置会在 ~/.bash_profile 中配置了 nvm/pyenv 等工具的机器上
      // 增加 400–600ms，对测试和小命令的快速迭代代价过高。

      child = shell.spawn({
        command: commandArg,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return new ToolResult({ content: `Error: failed to start background shell: ${e}` });
    }

    const entry: BackgroundShellEntry = {
      id: shellId,
      process: child,
      command: commandArg,
      cwd,
      logPath,
      startTime: performance.now(),
      status: "running",
      exitCode: null,
      signal: null,
      readOffset: 0,
      recentOutput: [],
      explicitKill: false,
    };
    this._activeShells.set(shellId, entry);

    this._attachShellListeners(entry);

    const archiveNote = archivedLogPath
      ? `\nprevious log (id was reused): ${archivedLogPath}`
      : "";
    return new ToolResult({
      content:
        `Started background shell '${shellId}'.\n` +
        `cwd: ${cwd}\n` +
        `log: ${logPath}${archiveNote}\n` +
        `Use \`bash_output(id="${shellId}")\` to inspect logs and \`await_event(seconds=60)\` to await shell exit.`,
    });
  }

  /**
   * 为跟踪的 shell 连接输出/退出处理。被
   * execBashBackground（新鲜生成）和 adoptRunningProcess（超时同步 bash 命令的交接）共享。
   */
  private _attachShellListeners(entry: BackgroundShellEntry): void {
    const { process: child, id: shellId, logPath } = entry;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.on("error", (error) => {
      entry.status = "failed";
      entry.exitCode = 1;
      entry.signal = null;
      this._deliverMessage({
        type: "system_notice", sender: "system", timestamp: Date.now(),
        content: `Background shell '${shellId}' failed to start: ${error}. Use \`bash_output(id="${shellId}")\` to inspect ${logPath}.`,
        tuiVisible: true,
      });
    });
    child.on("close", (code, signal) => {
      entry.exitCode = code;
      // 保留已被 kill_shell 记录的 kill-signal —
      // 孤孙子进程的 close 事件可能报告不同的
      // 信号或 null。
      if (entry.signal == null) entry.signal = signal;
      // kill_shell 在发出时同步将状态翻转为 "killed"，所以
      // 这里应该着陆的唯一路径是自然退出（状态
      // 仍然是 "running"）。使用退出码选择 exited/failed。
      if (entry.status === "running") {
        entry.status = code === 0 ? "exited" : "failed";
      }
      // 跳过对显式杀死的通知 — kill_shell 工具结果
      // 已经同步报告了结果。
      if (entry.explicitKill) return;
      const statusText = entry.status === "exited"
        ? "completed successfully"
        : `failed (exit ${code ?? 1})`;
      this._deliverMessage({
        type: "system_notice", sender: "system", timestamp: Date.now(),
        content: `Background shell '${shellId}' ${statusText}. Use \`bash_output(id="${shellId}")\` to inspect logs at ${logPath}.`,
        tuiVisible: true,
      });
    });
  }

  /**
   * 采用由超时结束的同步 bash 工具生成的活进程。进程作为跟踪的后台 shell 继续运行：
   * 到目前为止捕获的输出被植入一个新的日志文件，从此刻起
   * shell 的行为与通过 bash_background 启动的完全一样（输出记录、退出通知、kill_shell、bash_output）。
   *
   * 调用方必须在移交前停止消费子进程的 stdio。
   */
  adoptRunningProcess(opts: {
    child: ChildProcess;
    command: string;
    cwd: string;
    seedOutput?: string;
    /* Performance.now() 初始生成的时间戳。 */
    startedAt?: number;
  }): BackgroundShellEntry {
    const shellId = `shell-${++this._shellCounter}`;
    const logPath = join(this._getShellsDir(), `${shellId}.log`);
    writeFileSync(logPath, opts.seedOutput ?? "", "utf-8");

    const entry: BackgroundShellEntry = {
      id: shellId,
      process: opts.child,
      command: opts.command,
      cwd: opts.cwd,
      logPath,
      startTime: opts.startedAt ?? performance.now(),
      status: "running",
      exitCode: null,
      signal: null,
      readOffset: 0,
      recentOutput: [],
      explicitKill: false,
    };
    // 从同步阶段捕获的尾部填充 recentOutput。
    const seedLines = (opts.seedOutput ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    entry.recentOutput = seedLines.slice(-3);
    this._activeShells.set(shellId, entry);
    this._attachShellListeners(entry);

    // 在超时触发和采用之间进程可能已退出。
    if (opts.child.exitCode !== null || opts.child.signalCode !== null) {
      entry.exitCode = opts.child.exitCode;
      entry.signal = opts.child.signalCode;
      entry.status = opts.child.exitCode === 0 ? "exited" : "failed";
    }
    return entry;
  }

  execBashOutput(args: Record<string, unknown>): ToolResult {
    const idArg = argRequiredString("bash_output", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const tailLinesArg = argOptionalInteger("bash_output", args, "tail_lines");
    if (tailLinesArg instanceof ToolResult) return tailLinesArg;
    const maxCharsArg = argOptionalInteger("bash_output", args, "max_chars");
    if (maxCharsArg instanceof ToolResult) return maxCharsArg;

    const entry = this._activeShells.get(idArg);
    if (!entry) {
      return new ToolResult({ content: `Error: shell '${idArg}' not found.` });
    }

    const maxChars = Math.max(500, Math.min(80_000, maxCharsArg ?? 30_000));
    const fullText = existsSync(entry.logPath) ? readFileSync(entry.logPath, "utf-8") : "";
    let body = "";

    if (tailLinesArg !== undefined) {
      const lines = fullText.split("\n");
      body = lines.slice(-Math.max(1, tailLinesArg)).join("\n").trimEnd();
    } else {
      const fullBuffer = Buffer.from(fullText, "utf-8");
      const unread = fullBuffer.subarray(entry.readOffset).toString("utf-8");
      entry.readOffset = fullBuffer.length;
      if (!unread.trim()) {
        body = "(No new output since the last read.)";
      } else if (unread.length > maxChars) {
        const visible = unread.slice(0, maxChars);
        const omittedChars = unread.length - visible.length;
        const omittedLines = unread.slice(visible.length).split("\n").filter(Boolean).length;
        body =
          `${visible.trimEnd()}\n\n` +
          `[Truncated here because unread output exceeded ${maxChars} chars; skipped ${omittedChars.toLocaleString()} chars` +
          (omittedLines > 0 ? ` / ${omittedLines.toLocaleString()} lines` : "") +
          `. Full log: ${entry.logPath}]`;
      } else {
        body = unread.trimEnd();
      }
    }

    // 标题只提示一次已死亡 shell 状态；`status:` 字段以机器可读形式重复。
    // 我们有意不添加单独警告横幅 — 可操作指导（"启动新的 bash_background
    // 以恢复"）位于 tools.md，避免死亡状态读取被一大段醒目文字挤到下面。
    const header = entry.status === "running"
      ? `# Shell Output`
      : `# Shell Output — TERMINATED`;
    return new ToolResult({
      content:
        `${header}\n` +
        `id: ${entry.id}\n` +
        `status: ${entry.status}\n` +
        `log: ${entry.logPath}\n\n` +
        `${body || "(No output yet.)"}`,
    });
  }

  /**
   * 杀死一个跟踪的 shell（进程组，SIGTERM → SIGKILL 升级）。
   * 对于未知 id 和已终止的 shell 返回 `performed: false`
   * — 世界没有任何变化，所以调用方（例如 UI 停止
   * 路径）可以跳过通知代理。用于 kill_shell 工具和
   * 用户面向的停止操作。
   */
  async killShell(id: string, signalArg?: string): Promise<{ performed: boolean; message: string }> {
    const rawSignal = (signalArg?.trim() || "SIGTERM").toUpperCase();
    const signal = (rawSignal.startsWith("SIG") ? rawSignal : `SIG${rawSignal}`) as NodeJS.Signals;
    const KILL_WAIT_MS = 3_000;
    const KILL_FALLBACK_MS = 500;

    const entry = this._activeShells.get(id);
    if (!entry) {
      return { performed: false, message: `'${id}': not found.` };
    }
    if (entry.status !== "running") {
      return { performed: false, message: `'${id}': already ${entry.status}.` };
    }

    // 同步翻转状态：查询 `check_status` 的调用方（或
    // 在此调用后立即重用 bash_background 中的 id）
    // 绝对不能看到僵尸 "running" 条目。之前我们依赖
    // close 事件来更新状态，但当
    // shell 的后代（例如 npm 生成 vite）保持 stdio
    // 管道在 shell 本身退出后保持打开 — 条目会
    // 永远坐在那里作为 "running"。
    entry.explicitKill = true;
    entry.status = "killed";
    entry.signal = signal;

    // 向整个进程组发送信号，以便子/孙进程
    // 与 shell 一起死亡。这才是使 close
    // 事件在父进程上真正触发的原因。
    if (!BackgroundShellManager._killGroup(entry, signal)) {
      // 组 kill 和单子进程 kill 都抛出了异常。实践中这意味着进程已经消失（ESRCH）—
      // 我们对自己生成的任何进程都有发送信号的权限。保持 status="killed"
      // 是调用后世界状态的准确描述：没有运行中的进程附加到此条目，
      // 无论信号是否真正送达。
      return { performed: true, message: `'${id}': failed to send ${signal} (process likely already gone).` };
    }

    const message = await new Promise<string>((resolve) => {
      // 在分发和此处之间已退出？立即解决。
      if (entry.exitCode !== null || entry.process.exitCode !== null) {
        resolve(`'${id}': killed (signal=${signal}).`);
        return;
      }
      const onClose = () => {
        clearTimeout(timer);
        const exit = entry.exitCode;
        resolve(exit != null
          ? `'${id}': killed (signal=${entry.signal ?? signal}, exit=${exit}).`
          : `'${id}': killed (signal=${entry.signal ?? signal}).`);
      };
      const timer = setTimeout(() => {
        entry.process.removeListener("close", onClose);
        BackgroundShellManager._killGroup(entry, "SIGKILL");
        const escalated = `'${id}': SIGKILL after ${KILL_WAIT_MS}ms (initial ${signal} did not exit).`;
        entry.process.once("close", () => resolve(escalated));
        setTimeout(() => resolve(escalated), KILL_FALLBACK_MS); // 如果 close 永不触发则回退
      }, KILL_WAIT_MS);
      entry.process.once("close", onClose);
    });
    return { performed: true, message };
  }

  async execKillShell(args: Record<string, unknown>): Promise<ToolResult> {
    const idsArg = argRequiredStringArray("kill_shell", args, "ids");
    if (idsArg instanceof ToolResult) return idsArg;
    const signalArg = argOptionalString("kill_shell", args, "signal");
    if (signalArg instanceof ToolResult) return signalArg;

    const results = await Promise.all(idsArg.map((id) => this.killShell(id, signalArg)));
    return new ToolResult({ content: results.map((r) => r.message).join(" ") || "No shells specified." });
  }

  // ── 私有辅助函数 ────────────────────────────────────────────────

  private _getShellsDir(): string {
    const dir = join(this._getSessionArtifactsDir(), "shells");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private _normalizeShellId(id: string): string | null {
    const trimmed = id.trim();
    if (!trimmed) return null;
    return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
  }

  private _recordShellChunk(entry: BackgroundShellEntry, chunk: string): void {
    if (!chunk) return;
    appendFileSync(entry.logPath, chunk, "utf-8");
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      entry.recentOutput.push(line);
      if (entry.recentOutput.length > 3) entry.recentOutput.shift();
    }
  }

  private _resolveShellCwd(toolName: string, requested?: string): string | ToolResult {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) {
      return this._projectRoot;
    }

    try {
      return safePath({
        baseDir: this._projectRoot,
        requestedPath: trimmed,
        cwd: this._projectRoot,
        mustExist: true,
        expectDirectory: true,
        accessKind: "list",
      }).safePath!;
    } catch (err) {
      if (!(err instanceof SafePathError)) throw err;
      try {
        return safePath({
          baseDir: this._getSessionArtifactsDir(),
          requestedPath: trimmed,
          cwd: this._getSessionArtifactsDir(),
          mustExist: true,
          expectDirectory: true,
          accessKind: "list",
        }).safePath!;
      } catch (inner) {
        if (inner instanceof SafePathError) {
          return new ToolResult({
            content: `Error: invalid arguments for ${toolName}: cwd must stay within the project root or SESSION_ARTIFACTS.`,
          });
        }
        throw inner;
      }
    }
  }
}
