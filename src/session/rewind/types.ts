/** rewind journal 与已应用变更的类型契约。 */

import type { LogEntry } from "../../context/entry/types.js";

export interface RewindEngineDeps {
  /** 实时日志数组——引擎读取条目并修改其 meta（revert 标记）。 */
  getLog(): readonly LogEntry[];
  projectRoot: string;
  /** 会话产物目录（存储绑定时，用于定位 journal）。 */
  getArtifactsDir(): string | undefined;
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
