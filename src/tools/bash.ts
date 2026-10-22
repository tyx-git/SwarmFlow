/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";
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

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

/**
 * 构建传递给 bash 子进程的环境。这是 platform-shell provider
 * 的薄重导出，这样调用者不需要从 `src/platform/` 导入。
 * 保持命名导出是为了与现有导入（BackgroundShellManager）向后兼容。
 */
export function buildBashEnv(): NodeJS.ProcessEnv {
  return shell.buildChildEnv();
}

export function spillOutputToFile(
  baseDir: string,
  prefix: string,
  full: string,
): string | null {
  try {
    const dir = path.join(baseDir, "bash-output");
    mkdirSync(dir, { recursive: true });

    // Prune oldest spill files to keep the directory bounded. Best-effort
    // —any error here is ignored; spilling is more important than tidiness.
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
        try { unlinkSync(oldest.p); } catch { /* ignore */ }
      }
    } catch { /* ignore pruning failure */ }

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
  // Clamp timeout defensively (the dispatcher already validated presence/integer).
  timeout = Math.min(Math.max(1, timeout), BASH_MAX_TIMEOUT);

  // Resolve working directory
  let runCwd: string | undefined;
  if (cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return `ERROR: Working directory does not exist or is not a directory: ${cwd}`;
    }
    runCwd = cwd;
  }

  return new Promise<string>((resolve) => {
    // Shell selection, env filtering, and process-group setup live in
    // src/platform/shell. `killTree` reaps the whole descendant tree
    // so long-running grandchildren (e.g. vite under `npm run dev`)
    // don't leak as orphans.
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
      // On the timeout / abort path, each stream is truncated at `half`
      // (not BASH_MAX_OUTPUT_CHARS), since we have two streams to fit
      // inside the overall budget. So the spill check must use `half` too
      // —otherwise a 150K-stdout command that times out loses 50K of
      // output silently because total < BASH_MAX_OUTPUT_CHARS.
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
      // Release Node's references to the pipe file descriptors so the
      // parent process doesn't hold them open waiting for a late `close`.
      // Skipped on the background hand-off path: the shell manager owns
      // the child's stdio from that point on.
      if (!keepStdio) {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        try { child.stdin?.destroy(); } catch {}
      }
      resolve(text);
    };

    // Timeout hand-off: the command is NOT killed —it keeps running as a
    // tracked background shell. Output captured so far seeds the shell log;
    // from here on the shell manager owns the child's stdio. stdin is
    // closed (EOF) so commands stuck waiting for input get an honest "no
    // input is coming" signal and usually exit on their own.
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
        return false; // adoption failed —caller falls back to the kill path
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
      // No adoption available (standalone executeTool) or adoption failed:
      // fall back to the legacy kill path.
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
      // If timeout/abort already settled, ignore the delayed close.
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
        // Keep the numeric exit code for the model, but make the result a
        // first-class tool failure so the loop and TUI do not treat a command
        // failure as an ordinary successful tool result.
        parts.unshift(`ERROR: Command exited with code ${exitCode}`);
      }
      parts.push(`EXIT CODE: ${exitCode}`);

      // If output was truncated and a spill dir was provided, persist the
      // full output so the model can read_file the whole thing if needed.
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

// ------------------------------------------------------------------
// diff 预览辅助函数（用于 edit_file / write_file）
// ------------------------------------------------------------------

export function buildUnifiedDiffPreview(
  diff: string,
): { text: string; truncated: boolean } {
  if (!diff) {
    return { text: "(No textual changes.)", truncated: false };
  }

  type PreviewLine = {
    raw: string;
    oldLine?: number;
    newLine?: number;
  };

  const parsedLines: PreviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("-")) {
      parsedLines.push({ raw, oldLine });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("+")) {
      parsedLines.push({ raw, newLine });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsedLines.push({ raw, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    parsedLines.push({ raw });
  }

  const displayLineFor = (line: PreviewLine): number | undefined => {
    if (line.raw.startsWith("-")) return line.oldLine;
    if (line.raw.startsWith("+")) return line.newLine;
    if (line.raw.startsWith(" ")) return line.newLine;
    return undefined;
  };

  const maxLineNumber = parsedLines.reduce((max, line) => {
    return Math.max(max, displayLineFor(line) ?? 0);
  }, 0);
  const numberWidth = Math.max(String(maxLineNumber || 0).length, 2);

  const formatLine = (line: PreviewLine): string => {
    const displayLine = displayLineFor(line);
    const lineCol = displayLine == null ? "".padStart(numberWidth, " ") : String(displayLine).padStart(numberWidth, " ");
    return `${lineCol} ${line.raw}`;
  };

  // Keep every changed line in the preview. Context omission is already handled
  // upstream by the unified diff hunking logic, which limits unchanged lines
  // around each change instead of globally truncating the rendered preview.
  const text = parsedLines.map(formatLine).join("\n");
  return { text, truncated: false };
}

/**
 * 最小化 unified diff：从两个行数组生成 unified diff 字符串。
 */
export function simpleUnifiedDiff(
  a: string[],
  b: string[],
  labelA: string,
  labelB: string,
): string {
  // Use a simple LCS-based approach
  const n = a.length;
  const m = b.length;

  // For very large files, fall back to a simpler comparison
  if (n * m > 10_000_000) {
    // Too large for full LCS, just show stats
    return (
      `--- ${labelA}\n+++ ${labelB}\n` +
      `(Files differ: ${n} lines vs ${m} lines, diff too large to compute)`
    );
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find edit script
  const ops: Array<{ type: "equal" | "delete" | "insert"; line: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const contextLines = 3;
  const hunks: string[] = [];
  let hunkStart = -1;
  let hunkLines: string[] = [];
  let aLine = 0;
  let bLine = 0;
  let aStart = 0;
  let bStart = 0;
  let aCount = 0;
  let bCount = 0;
  let lastChangeIdx = -contextLines - 1;

  function flushHunk(): void {
    if (hunkLines.length > 0) {
      hunks.push(
        `@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n` +
        hunkLines.join("\n"),
      );
      hunkLines = [];
    }
  }

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (hunkStart === -1 || idx - lastChangeIdx > contextLines * 2) {
        // Start a new hunk
        flushHunk();
        hunkStart = idx;
        aStart = aLine;
        bStart = bLine;
        aCount = 0;
        bCount = 0;
        // Add leading context
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx - lastChangeIdx <= contextLines) {
      if (op.type === "equal") {
        hunkLines.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        hunkLines.push(`-${op.line}`);
        aCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        bCount++;
      }
    }

    if (op.type === "equal" || op.type === "delete") aLine++;
    if (op.type === "equal" || op.type === "insert") bLine++;
  }

  flushHunk();

  if (hunks.length === 0) return "";
  return `--- ${labelA}\n+++ ${labelB}\n${hunks.join("\n")}`;
}

export function formatUtcOffset(date: Date): string {
  // getTimezoneOffset returns minutes behind UTC; invert for UTC offset HH:MM.
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
