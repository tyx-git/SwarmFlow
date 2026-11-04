/** bash / bash_background 执行器：超时、输出截断与溢出落盘，并提供 time 与后台 shell 接管入口。 */

import {
  existsSync,
  statSync,
  readdirSync,
  writeFileSync as fsWriteFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import path from "node:path";

import { shell } from "../platform/index.js";

import { truncateMiddle } from "./output-truncation.js";

import {
  BASH_SPILL_KEEP_LAST,
  BASH_MAX_TIMEOUT,
  BASH_TIMEOUT_KILL_SIGNAL,
  BASH_MAX_OUTPUT_CHARS,
} from "./limits.js";

export function spillOutputToFile(
  baseDir: string,
  prefix: string,
  full: string,
): string | null {
  try {
    const dir = path.join(baseDir, "bash-output");
    mkdirSync(dir, { recursive: true });

    // 修剪最旧的溢出文件，让目录保持有限大小。尽力而为：
    // 此处的任何错误都被忽略，落盘比整洁更重要。
    try {
      const entries = readdirSync(dir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
          const p = path.join(dir, name);
          try { return { p, mtime: statSync(p).mtimeMs }; }
          catch { return null; }
        })
        .filter((e): e is { p: string; mtime: number } => e !== null)
        .sort((a, b) => a.mtime - b.mtime);
      while (entries.length >= BASH_SPILL_KEEP_LAST) {
        const oldest = entries.shift();
        if (!oldest) break;
        try { unlinkSync(oldest.p); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略修剪失败 */ }

    const file = path.join(dir, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.log`);
    fsWriteFileSync(file, full, { encoding: "utf-8" });
    return file;
  } catch {
    return null;
  }
}

export async function toolBash(
  command: string,
  timeout: number,
  cwd = "",
  opts: { signal?: AbortSignal; spillDir?: string; adoptShell?: AdoptShellFn; hasTools?: (name: string) => boolean } = {},
): Promise<string> {
  // 防御性地收紧超时（调度器已校验存在性与整数性）。
  timeout = Math.min(Math.max(1, timeout), BASH_MAX_TIMEOUT);

  // 解析工作目录
  let runCwd: string | undefined;
  if (cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return `ERROR: Working directory does not exist or is not a directory: ${cwd}`;
    }
    runCwd = cwd;
  }

  return new Promise<string>((resolve) => {
    // shell 选择、环境变量过滤与进程组设置都在 src/platform/shell。
    // `killTree` 会收掉整棵子孙进程树，`npm run dev` 下的 vite 这类
    // 长跑的孙进程才不会泄漏成孤儿。
    const child = shell.spawn({ command, cwd: runCwd });
    const spawnedAt = performance.now();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxBuffer = 10 * 1024 * 1024; // 10 MB

    let resolved = false;
    let cause: "close" | "timeout" | "abort" | "error" = "close";

    const killGroup = () => {
      shell.killTree(child, BASH_TIMEOUT_KILL_SIGNAL);
    };

    const collectPartial = (): string => {
      const out = Buffer.concat(stdoutChunks).toString("utf-8");
      const err = Buffer.concat(stderrChunks).toString("utf-8");
      // 超时 / 中断路径下，两条流各截到 `half`（而不是
      // BASH_MAX_OUTPUT_CHARS），因为总预算要装下两条流。
      // 因此溢出判断也必须用 `half`：否则一条 stdout 有 150K 的命令
      // 超时后，只因总量 < BASH_MAX_OUTPUT_CHARS 就静默丢掉 50K 输出。
      const half = Math.floor(BASH_MAX_OUTPUT_CHARS / 2);
      const parts: string[] = [];
      if (out) parts.push(`PARTIAL STDOUT:\n${truncateMiddle(out, half)}`);
      if (err) parts.push(`PARTIAL STDERR:\n${truncateMiddle(err, half)}`);
      const willTruncate = out.length > half || err.length > half;
      if (opts.spillDir && willTruncate) {
        const full =
          (out ? `==== STDOUT ====\n${out}\n` : "") +
          (err ? `==== STDERR ====\n${err}\n` : "");
        const spill = spillOutputToFile(opts.spillDir, "bash-partial", full);
        if (spill) {
          parts.push(
            `Full untruncated output saved to: ${spill}\n` +
            `(read it with \`read_file\`; \`tail_lines=200\` shows the latest output.)`,
          );
        }
      }
      return parts.join("\n");
    };

    const finish = (text: string, keepStdio = false) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // 释放 Node 对管道文件描述符的引用，父进程才不会一直握着它们
      // 等一个迟到的 `close`。后台移交路径跳过此步：从那一刻起，
      // 子进程的 stdio 归 shell 管理器所有。
      if (!keepStdio) {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        try { child.stdin?.destroy(); } catch {}
      }
      resolve(text);
    };

    // 超时移交：不杀命令，让它继续作为被追踪的后台 shell 运行。已捕获的
    // 输出作为 shell 日志的种子；此后子进程的 stdio 归 shell 管理器。
    // stdin 会被关闭（EOF），卡在等输入的命令因此得到「不会再有输入」的
    // 明确信号，通常自行退出。
    const handoffToBackground = (): boolean => {
      if (resolved || !opts.adoptShell) return false;
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      const out = Buffer.concat(stdoutChunks).toString("utf-8");
      const err = Buffer.concat(stderrChunks).toString("utf-8");
      const seedOutput =
        (out ? `==== STDOUT (sync phase) ====\n${out}\n` : "") +
        (err ? `==== STDERR (sync phase) ====\n${err}\n` : "");
      let adopted: { id: string; logPath: string };
      try {
        adopted = opts.adoptShell({
          child,
          command,
          cwd: runCwd ?? process.cwd(),
          seedOutput,
          startedAt: spawnedAt,
        });
      } catch {
        return false; // 接管失败——调用方退回 kill 路径
      }
      try { child.stdin?.destroy(); } catch {}
      const partial = collectPartial();
      // 文案只点名真实存在的等待/终止工具；读日志统一走 read_file。
      const canAwaitEvent = opts.hasTools?.("await_event") === true;
      const canKillShell = opts.hasTools?.("kill_shell") === true;
      const readHint = `Read the log with \`read_file\` (\`tail_lines=200\` shows the latest output)`;
      const actionHints: string[] = [];
      if (canAwaitEvent) actionHints.push("wait with `await_event`");
      if (canKillShell) actionHints.push("stop it with `kill_shell`");
      const followUp =
        `Do not re-run it: its side effects are still in progress. ${readHint} to see how it ends.` +
        (actionHints.length > 0 ? ` You can ${actionHints.join(", or ")}.` : "");
      const header =
        `MOVED TO BACKGROUND: the command did not finish within ${timeout}s. It was NOT killed —` +
        `it continues running as background shell '${adopted.id}' (log: ${adopted.logPath}).\n` +
        followUp +
        (canKillShell
          ? `\nIf the partial output below suggests the command was stuck or waiting for interactive input, ` +
            `remember to kill_shell it rather than leaving a zombie shell behind.`
          : "");
      finish(partial ? `${header}\n\n${partial}` : header, /* keepStdio */ true);
      return true;
    };

    const finishEarly = () => {
      const partial = collectPartial();
      const header =
        cause === "timeout"
          ? `ERROR: Command timed out after ${timeout}s and was killed (SIGKILL on process group; ` +
            `background hand-off was unavailable). NOTE: a timeout is NOT automatically a failure —` +
            `for mutating commands, side effects up to the kill point may have completed. Inspect the ` +
            `partial output and resulting filesystem / state before deciding to retry.`
          : `ERROR: Command was interrupted and killed (SIGKILL on process group) before completing.`;
      finish(partial ? `${header}\n\n${partial}` : header);
    };

    const onAbort = () => {
      cause = "abort";
      killGroup();
      finishEarly();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen < maxBuffer) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      cause = "timeout";
      if (handoffToBackground()) return;
      // 没有可用的接管（独立调用 executeTool）或接管失败：
      // 退回旧的 kill 路径。
      killGroup();
      finishEarly();
    }, timeout * 1000);

    if (opts.signal) {
      if (opts.signal.aborted) {
        cause = "abort";
        killGroup();
        finishEarly();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      // 超时/中断已定局时，忽略迟到的 close。
      if (resolved) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const parts: string[] = [];
      const total = stdout.length + stderr.length;
      const willTruncate =
        stdout.length > BASH_MAX_OUTPUT_CHARS ||
        stderr.length > BASH_MAX_OUTPUT_CHARS;

      if (stdout) {
        parts.push(`STDOUT:\n${truncateMiddle(stdout, BASH_MAX_OUTPUT_CHARS)}`);
      }
      if (stderr) {
        parts.push(`STDERR:\n${truncateMiddle(stderr, BASH_MAX_OUTPUT_CHARS)}`);
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        // 数字退出码留给模型，同时把结果标成一等公民的工具失败，
        // 免得 agent loop 与 TUI 把命令失败当成普通的成功结果。
        parts.unshift(`ERROR: Command exited with code ${exitCode}`);
      }
      parts.push(`EXIT CODE: ${exitCode}`);

      // 输出被截断且给了溢出目录时，把完整输出落盘，
      // 模型需要时可用 read_file 读全文。
      if (willTruncate && opts.spillDir && total > 0) {
        const full =
          (stdout ? `==== STDOUT ====\n${stdout}\n` : "") +
          (stderr ? `==== STDERR ====\n${stderr}\n` : "");
        const spill = spillOutputToFile(opts.spillDir, "bash", full);
        if (spill) {
          parts.push(
            `Full untruncated output saved to: ${spill}\n` +
            `(${total.toLocaleString()} total chars; read it with \`read_file\`, \`tail_lines=200\` for the latest output, or grep it.)`,
          );
        }
      }
      finish(parts.join("\n"));
    });

    child.on("error", (err) => {
      cause = "error";
      finish(`ERROR: ${err.message}`);
    });
  });
}

export function formatUtcOffset(date: Date): string {
  // getTimezoneOffset 返回落后 UTC 的分钟数，取反得到 UTC 偏移 HH:MM。
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function toolTime(): string {
  const now = new Date();
  const tzIana = Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  const tzName =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value || "Unknown";
  const offset = formatUtcOffset(now);
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const iso = `${local.replace(" ", "T")}${offset}`;
  return [
    `Current local time: ${local}`,
    `Timezone: ${tzIana} (${tzName}, UTC${offset})`,
    `ISO 8601: ${iso}`,
  ].join("\n");
}

// ======================================================================
// Dispatcher
// ======================================================================

/**
 * 由调度闭包捕获的每个会话静态上下文。
 *
 * 这里的 `signal` 是可选的，因为 `executeTool` 在同一个 ctx 对象中接受它
 * 是为了调用者方便，但它是一个按调用运行的运行时值，
 * 被提取并作为单独参数传递给每个执行器。
 */
/**
 * 将一个活的、超时的同步 bash 进程移交给会话的后台 shell 管理器。
 * 返回被追踪 shell 的 id 和日志路径。
 */
export interface AdoptShellRequest {
  child: import("node:child_process").ChildProcess;
  command: string;
  cwd: string;
  /** 在同步阶段捕获的输出，播种到 shell 日志中。 */
  seedOutput: string;
  /** 原始生成的 performance.now() 时间戳。 */
  startedAt: number;
}

export type AdoptShellFn = (req: AdoptShellRequest) => { id: string; logPath: string };
