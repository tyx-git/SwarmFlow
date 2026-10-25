/** rewind journal 与已应用变更的类型契约。 */

import type { LogEntry } from "../../context/entry/types.js";
import type { EntryFlags } from "../../config/log-jsonl.js";

export interface RewindEngineDeps {
  /** 实时日志数组——引擎读取条目并修改其 meta（revert 标记）。 */
  getLog(): readonly LogEntry[];
  /** 闭集标记变更走网关，避免绕过追加式持久化。 */
  patchFlags(ids: readonly string[], flags: EntryFlags): void;
  projectRoot: string;
  /** 会话产物目录（存储绑定时，用于定位 journal）。 */
  getArtifactsDir(): string | undefined;
  /**
   * 已归档条目的 meta（按需从 archive/ 读取）。
   * 归档会清空旧窗口的 meta，回退计划仍需 fileMutation / bashMutation。
   */
  getArchivedMeta?(entryId: string): Record<string, unknown> | undefined;
}

/** `Session.getRewindTargets()` 返回的单个回退点（按用户轮次聚合）。 */
export interface RewindTargetTurn {
  turnIndex: number;
  entryIndex: number;
  preview: string;
  timestamp: number;
  fileCount: number;
  additions: number;
  deletions: number;
  filesReverted: boolean;
}

export interface RewindPreimage {
  path: string;
  kind: "missing" | "file" | "directory" | "symlink";
  backupPath?: string;
  symlinkTarget?: string;
  symlinkType?: "file" | "dir";
}

export interface RewindAppliedMutation {
  entryId: string;
  bashEntryIndex?: number;
}

export interface RewindJournal {
  version: 1;
  filePath: string;
  state: "preparing" | "ready";
  backupDir: string;
  preimages: RewindPreimage[];
  applied: RewindAppliedMutation[];
  pending: RewindAppliedMutation[];
}
