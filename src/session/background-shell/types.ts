/**
 * 后台 shell 生命周期管理器。
 *
 * 拥有生成、跟踪、读取输出和终止
 * 后台 shell 进程。从 Session 中提取以保持
 * 主文件更小且责任边界清晰。
 */

import { type ChildProcess } from "node:child_process";

import { shell } from "../../platform/index.js";

import type { MessageEnvelope } from "../tree-types.js";

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
  /**
   * 后台 shell 日志目录。日志放在项目内的 `.swarmflow/<session_id>/shells`，
   * 便于用户直接查看；同步输出的 spill 日志仍走 session artifacts。
   */
  getShellLogDir: () => string;
  deliverMessage: (msg: MessageEnvelope) => void;
  /**
   * 本会话是否拥有某个工具。读日志统一走 read_file；
   * 该谓词只用于决定是否点名 await_event / kill_shell。
   */
  hasTools: (name: string) => boolean;
}

// 每个 id 保留归档 shell 日志。当模型杀死一个 shell 后用相同 id
// 启动新 shell 时，旧日志会被重命名；这里只保留最近 N 个重命名，
// 避免长会话中的目录无限增长。
//
// 选择 8 的理由：典型开发服务器重启前会写入约 200 KB；
// 8 × 200 KB ≈ 每个 id 最大 1.6 MB。这里镜像 src/tools/limits.ts 中
// BASH_SPILL_KEEP_LAST = 32 的保留惯例；若真实使用超过此范围再调整。

