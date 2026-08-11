/**
 * SwarmFlow 轻量诊断日志 —— 专用于排查运行时崩溃。
 *
 * 设计原则：
 *   - 零运行时依赖，避免引入新的崩溃面。
 *   - 写入项目本地 `.logs/` 目录，便于人工复现后回溯。
 *   - 进程崩溃时也能尽量 flush（每次 write 同步落盘）。
 *   - 通过环境变量精细控制，不污染生产输出：
 *       SWARMFLOW_LOG=0      关闭（默认）
 *       SWARMFLOW_LOG=1      写入 stderr + `.logs/`
 *       SWARMFLOW_LOG=file   仅写文件
 *       SWARMFLOW_LOG_DIR    自定义目录（默认 .logs/）
 *       SWARMFLOW_LOG_LEVEL  trace|debug|info|warn|error|fatal
 *
 * 注意：本模块不假设特定运行时行为，使用纯 `node:` API，崩溃路径
 * 仅做一次 `appendFileSync`，绝不再 throw。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** 子 logger：合并上下文，后续调用自动带上这些字段。 */
  child(bindings: LogFields): Logger;
}

let currentSessionId = 0;
let currentLogFile: string | null = null;
let currentLevel: LogLevel = "info";
let currentMode: "off" | "stderr+file" | "file" = "off";
let fileInitFailed = false;

function detectMode(): "off" | "stderr+file" | "file" {
  const raw = (process.env.SWARMFLOW_LOG ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return "stderr+file";
  if (raw === "file") return "file";
  return "off";
}

function detectLevel(): LogLevel {
  const raw = (process.env.SWARMFLOW_LOG_LEVEL ?? "debug").trim().toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "debug";
}

function initLogFile(): string | null {
  if (currentLogFile) return currentLogFile;
  if (fileInitFailed) return null;
  try {
    const dir = resolve(process.env.SWARMFLOW_LOG_DIR ?? join(process.cwd(), ".logs"));
    mkdirSync(dir, { recursive: true });
    currentSessionId += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const pid = process.pid;
    const filename = `swarmflow-${stamp}-pid${pid}-${String(currentSessionId).padStart(3, "0")}.log`;
    currentLogFile = join(dir, filename);
    return currentLogFile;
  } catch {
    fileInitFailed = true;
    return null;
  }
}

function writeLine(level: LogLevel, line: string): void {
  if (currentMode === "off") return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  lastLogLine = line;

  if (currentMode === "stderr+file") {
    try {
      process.stderr.write(line + "\n");
    } catch {
      /* swallow: stderr may be closed in some sandboxes */
    }
  }

  const file = initLogFile();
  if (file) {
    try {
      appendFileSync(file, line + "\n");
    } catch {
      fileInitFailed = true;
    }
  }
}

function formatLine(level: LogLevel, bindings: LogFields, msg: string, fields?: LogFields): string {
  const merged: LogFields = {
    t: new Date().toISOString(),
    level,
    pid: process.pid,
    ppid: process.ppid,
    exec: process.execPath,
    argv: process.argv.slice(0, 4),
    cwd: process.cwd(),
    uptimeMs: Math.round(process.uptime() * 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ...bindings,
    msg,
    ...(fields ?? {}),
  };

  // 始终输出单行 JSON，便于 grep/解析。
  try {
    return JSON.stringify(merged, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch {
    return `${merged.t} ${level} ${msg}`;
  }
}

function makeLogger(bindings: LogFields): Logger {
  const log = (level: LogLevel) => (msg: string, fields?: LogFields): void => {
    writeLine(level, formatLine(level, bindings, msg, fields));
  };
  return {
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    fatal: log("fatal"),
    child(extra: LogFields): Logger {
      return makeLogger({ ...bindings, ...extra });
    },
  };
}

// 进程级初始化。重复调用是幂等的。
let heartbeatStarted = false;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let lastEventLoopMs = 0;
let lastLogLine: string | null = null;
let processHandlersInstalled = false;

export function initLogger(): void {
  currentMode = detectMode();
  currentLevel = detectLevel();
  if (currentMode !== "off") {
    initLogFile();
  }

  // 捕捉未被捕获的异常，避免 panic 时丢失信号。
  if (!processHandlersInstalled) {
    processHandlersInstalled = true;
    process.on("uncaughtException", (err) => {
    try {
      writeLine("fatal", formatLine("fatal", { kind: "uncaughtException" }, err.message, { stack: err.stack }));
    } catch {
      /* swallow */
    }
  });
  process.on("unhandledRejection", (reason) => {
    try {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      writeLine("fatal", formatLine("fatal", { kind: "unhandledRejection" }, err.message, { stack: err.stack }));
    } catch {
      /* swallow */
    }
  });
  process.on("beforeExit", (code) => {
    writeLine("info", formatLine("info", { kind: "beforeExit" }, "process beforeExit", { code }));
  });
  }

  startHeartbeat();
}

/**
 * 周期性心跳：把最近事件写入 .logs/last-heartbeat.json。
 *
 * 设计目的：native 段错误时 JS 回调不会运行，
 * uncaughtException 也不会触发。心跳文件是“最后的挣扎”，
 * 至少能留下崩溃前几秒的运行时状态供事后分析。
 */
function startHeartbeat(): void {
  if (heartbeatStarted) return;
  if (currentMode === "off") return; // 关闭时不做任何 I/O
  heartbeatStarted = true;

  // 测量 event loop 延迟：setTimeout 实际触发 - 期望触发
  let lastTick = Date.now();
  setInterval(() => {
    const expected = lastTick + 5_000;
    const now = Date.now();
    lastEventLoopMs = now - expected;
    lastTick = now;
  }, 5_000);

  heartbeatInterval = setInterval(() => {
    try {
      const file = initLogFile();
      if (!file) return;
      const dir = file.replace(/[^/]+$/, "");
      const heartbeatPath = `${dir}last-heartbeat.json`;
      const payload = {
        t: new Date().toISOString(),
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        eventLoopLagMs: lastEventLoopMs,
        activeHandles: (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? null,
        activeRequests: (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.().length ?? null,
        lastLogLine,
        logFile: file,
      };
      appendFileSync(heartbeatPath, JSON.stringify(payload) + "\n");
    } catch {
      /* swallow */
    }
  }, 5_000);
  // 阻止进程被这个定时器单独挂住，但崩溃时不阻止退出。
  if (typeof heartbeatInterval === "object" && heartbeatInterval !== null && "unref" in heartbeatInterval) {
    (heartbeatInterval as { unref: () => void }).unref();
  }
}

/** 进程级默认 logger，初始化后可用。 */
export function getLogger(component: string): Logger {
  return makeLogger({ component });
}

/** 诊断：返回当前日志文件路径，未启用时返回 null。 */
export function getCurrentLogFile(): string | null {
  return currentLogFile;
}

/** 诊断：测试或脚本需要强制开启并重定向到自定义目录时使用。 */
export function configureLogging(opts: { mode: "off" | "stderr+file" | "file"; level?: LogLevel; dir?: string }): void {
  currentMode = opts.mode;
  if (opts.level) currentLevel = opts.level;
  if (opts.dir) process.env.SWARMFLOW_LOG_DIR = opts.dir;
  currentLogFile = null;
  fileInitFailed = false;
  if (currentMode !== "off") initLogFile();
}
