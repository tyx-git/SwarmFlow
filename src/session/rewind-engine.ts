/**
 * RewindEngine —— 文件/bash 回退规划和应用。
 *
 * 从 Session 提取出来（P2.1）：拥有反向 patch 规划、
 * bash 操作 revert 分类/执行，以及崩溃恢复日志。
 * 它读取会话日志并修改条目 meta（revert 标记），
 * 但不触碰 turn/session 状态——守卫和变更通知留在 Session。
 *
 * 核心概念：
 * - planRewind：从指定 turn 之后收集所有文件 mutations，
 *   按路径分组，分类为 applicable/warning/conflict
 * - applyFiles：执行反向 patch，将 mutation 标记为已回退
 * - crash recovery journal：应用开始前写入预镜像，
 *   若中途崩溃则从 journal 恢复
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { applyPatch, parsePatch } from "diff";

import type { LogEntry } from "../context/log-entry.js";
import type { FileMutation, BashMutation, BashMutationEntry } from "../tools/basic.js";
import type {
  RewindPlan,
  RewindApplyResult,
  RewindPathMutation,
  BashRewindEntry,
} from "../ui/contracts.js";

export interface RewindEngineDeps {
  /** 实时日志数组——引擎读取条目并修改其 meta（revert 标记）。 */
  getLog(): readonly LogEntry[];
  projectRoot: string;
  /** 会话产物目录（存储绑定时，用于定位 journal）。 */
  getArtifactsDir(): string | undefined;
}

export class RewindEngine {
  constructor(private readonly deps: RewindEngineDeps) {}

  /**
   * 构建回退计划：从 fromTurnIndex 之后收集所有 live 文件 mutations，
   * 按路径分组，分类为 applicable/warning/conflict。
   */
  async planRewind(fromTurnIndex: number): Promise<RewindPlan> {
    const mutations = this._collectLiveFileMutations(fromTurnIndex);
    const byPath = new Map<string, Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }>>();
    for (const m of mutations) {
      const arr = byPath.get(m.mutation.path) ?? [];
      arr.push(m);
      byPath.set(m.mutation.path, arr);
    }

    const applicable: RewindPlan["applicable"] = [];
    const warnings: RewindPlan["warnings"] = [];
    const conflicts: RewindPlan["conflicts"] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    const fileLineCounts = new Map<string, number>();

    for (const [filePath, muts] of byPath) {
      // 从新到旧排序——反向 patch 按此顺序应用
      muts.sort((a, b) => b.turnIndex - a.turnIndex || mutations.indexOf(b) - mutations.indexOf(a));

      // 检查是否有未跟踪的 mutations
      if (muts.some(m => m.mutation.untracked || !m.mutation.reversePatch)) {
        conflicts.push({ path: filePath, reason: "untracked" });
        continue;
      }

      // 读取磁盘当前状态
      let diskContent: string;
      try {
        diskContent = readFileSync(filePath, { encoding: "utf-8" });
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          conflicts.push({ path: filePath, reason: "file_deleted" });
        } else {
          conflicts.push({ path: filePath, reason: "file_not_readable" });
        }
        continue;
      }

      const diskSha = createHash("sha256").update(diskContent, "utf-8").digest("hex");
      const latestPostSha = muts[0].mutation.postImageSha;
      const isDiskModified = diskSha !== latestPostSha;

      // 尝试应用反向 patch 链
      const pathMutations: RewindPathMutation[] = muts.map(m => ({
        entryId: m.entryId,
        turnIndex: m.turnIndex,
        reversePatch: m.mutation.reversePatch!,
      }));

      let current: string | false = diskContent;
      for (const pm of pathMutations) {
        current = applyPatch(current as string, pm.reversePatch);
        if (current === false) break;
      }

      if (current === false) {
        conflicts.push({ path: filePath, reason: "patch_failed" });
        continue;
      }

      // 从 patch 中统计变更行数
      let pathAdd = 0;
      let pathDel = 0;
      for (const pm of pathMutations) {
        const parsed = parsePatch(pm.reversePatch);
        for (const p of parsed) {
          for (const hunk of p.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+") && !line.startsWith("+++")) pathDel++;
              if (line.startsWith("-") && !line.startsWith("---")) pathAdd++;
            }
          }
        }
      }
      totalAdditions += pathAdd;
      totalDeletions += pathDel;
      fileLineCounts.set(filePath, pathAdd + pathDel);

      if (isDiskModified) {
        warnings.push({ path: filePath, reason: "disk_modified", mutations: pathMutations });
      } else {
        applicable.push({ path: filePath, mutations: pathMutations });
      }
    }

    // 摘要文件：变更行数最多的那个
    let summaryFile = "";
    let maxLines = 0;
    for (const [p, count] of fileLineCounts) {
      if (count > maxLines) { maxLines = count; summaryFile = p; }
    }
    const totalFiles = applicable.length + warnings.length;
    const otherFileCount = Math.max(0, totalFiles - 1);

    const bashEntries = this._planBashRewindEntries(fromTurnIndex);

    return {
      fromTurnIndex,
      applicable,
      warnings,
      conflicts,
      bashEntries,
      totalAdditions,
      totalDeletions,
      summaryFile: summaryFile ? join(relative(this.deps.projectRoot, summaryFile)) : "",
      otherFileCount,
    };
  }

  /**
   * 应用反向 patches 并将 mutations 标记为已回退。
   * 不触碰会话日志结构；调用方拥有守卫（无进行中的 turn）
   * 和应用后通知。
   */
  async applyFiles(plan: RewindPlan): Promise<RewindApplyResult> {
    const journalPath = this._writeRewindJournal(plan);

    const revertedPaths: string[] = [];
    const conflictPaths: string[] = [];
    const bashReverted: string[] = [];
    const bashSkipped: string[] = [];

    // 构建统一时间线：按日志位置交错文件和 bash 操作。
    type RewindOp =
      | { type: "file"; logIndex: number; entry: (typeof plan.applicable)[0] }
      | { type: "bash"; logIndex: number; be: BashRewindEntry };

    const ops: RewindOp[] = [];
    for (const entry of [...plan.applicable, ...plan.warnings]) {
      const newestLogIndex = this._findLogIndex(entry.mutations[0]?.entryId ?? "");
      ops.push({ type: "file", logIndex: newestLogIndex, entry });
    }
    for (const be of plan.bashEntries) {
      ops.push({ type: "bash", logIndex: be.logIndex, be });
    }
    // 按 logIndex 降序排序（从新到旧）
    ops.sort((a, b) => b.logIndex - a.logIndex);

    try {
      for (const op of ops) {
        if (op.type === "bash") {
          const be = op.be;
          // 执行时重新分类——之前的文件回退可能改变了磁盘状态，
          // 将计划时的 conflict 变为 applicable。
          const liveStatus = this._classifyBashRewindEntry(
            be.entryId, be.turnIndex, be.logIndex, be.bashEntryIndex, be.mutation,
          );
          if (liveStatus.status === "conflict") {
            const detailSuffix = liveStatus.conflictDetails?.length
              ? ": " + liveStatus.conflictDetails.join("; ")
              : "";
            bashSkipped.push(`${be.description} (${liveStatus.conflictReason})${detailSuffix}`);
            continue;
          }
          const success = this._executeBashRevert(be);
          if (success) {
            bashReverted.push(be.description);
            this._markBashMutationEntryReverted(be.entryId, be.bashEntryIndex);
          } else {
            bashSkipped.push(be.description);
          }
        } else {
          const entry = op.entry;
          let content: string;
          try {
            content = readFileSync(entry.path, { encoding: "utf-8" });
          } catch {
            conflictPaths.push(entry.path);
            continue;
          }
          let failed = false;
          for (const mut of entry.mutations) {
            const result = applyPatch(content, mut.reversePatch);
            if (result === false) { failed = true; break; }
            content = result;
          }
          if (failed) {
            conflictPaths.push(entry.path);
            continue;
          }
          const earliestMut = entry.mutations[entry.mutations.length - 1];
          const createdFile = this._isMutationFileCreation(earliestMut.entryId);
          if (content === "" && createdFile) {
            try { unlinkSync(entry.path); } catch { /* ignore ENOENT */ }
          } else {
            writeFileSync(entry.path, content, { encoding: "utf-8" });
          }
          revertedPaths.push(entry.path);

          for (const mut of entry.mutations) {
            this._markMutationReverted(mut.entryId);
          }
        }
      }
    } catch (e) {
      this._restoreFromRewindJournal(journalPath);
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: `Rewind failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    this._deleteRewindJournal(journalPath);

    return { revertedPaths, conflictPaths, bashReverted, bashSkipped };
  }

  /**
   * 检测并从崩溃的回退中恢复（journal 残留时触发）。
   */
  recoverJournalIfNeeded(): void {
    const journalPath = this._getRewindJournalPath();
    if (!existsSync(journalPath)) return;
    this._restoreFromRewindJournal(journalPath);
    this._deleteRewindJournal(journalPath);
  }

  /** 执行 bash revert（mkdir/cp/mv 的逆向操作）。 */
  private _executeBashRevert(be: BashRewindEntry): boolean {
    const me = be.mutation;
    try {
      if (me.kind === "mkdir" && me.createdDirs) {
        const dirs = [...me.createdDirs].reverse();
        for (const dir of dirs) {
          if (existsSync(dir)) rmdirSync(dir);
        }
        return true;
      }

      if (me.kind === "cp") {
        if (!me.target) return false;
        if (me.targetExisted && me.backupPath) {
          copyFileSync(me.backupPath, me.target);
          try { unlinkSync(me.backupPath); } catch { /* ignore */ }
        } else if (existsSync(me.target)) {
          const st = statSync(me.target);
          if (st.isDirectory()) {
            rmSync(me.target, { recursive: true });
          } else {
            unlinkSync(me.target);
          }
        }
        return true;
      }

      if (me.kind === "mv") {
        if (!me.source || !me.target) return false;
        renameSync(me.target, me.source);
        if (me.targetExisted && me.backupPath) {
          copyFileSync(me.backupPath, me.target);
          try { unlinkSync(me.backupPath); } catch { /* ignore */ }
        }
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** 将指定的 bash mutation 条目标记为已回退。 */
  private _markBashMutationEntryReverted(entryId: string, bashEntryIndex: number): void {
    const entry = this.deps.getLog().find(e => e.id === entryId);
    if (!entry) return;
    const meta = entry.meta as Record<string, unknown>;
    const indices = (meta.bashMutationRevertedIndices as number[]) ?? [];
    if (!indices.includes(bashEntryIndex)) indices.push(bashEntryIndex);
    meta.bashMutationRevertedIndices = indices;

    // 若所有条目都已回退，同时设置遗留标志
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const bm = toolMeta?.bashMutation as BashMutation | undefined;
    if (bm && indices.length >= bm.entries.length) {
      meta.bashMutationReverted = true;
    }
  }

  /** 收集 fromTurnIndex 之后所有未回退的文件 mutations。 */
  private _collectLiveFileMutations(
    fromTurnIndex: number,
  ): Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }> {
    const log = this.deps.getLog();
    const results: Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }> = [];
    for (let li = 0; li < log.length; li++) {
      const entry = log[li]!;
      if (entry.turnIndex < fromTurnIndex) continue;
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (meta.fileMutationReverted) continue;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const fm = toolMeta?.fileMutation as FileMutation | undefined;
      if (!fm) continue;
      results.push({ entryId: entry.id, turnIndex: entry.turnIndex, logIndex: li, mutation: fm });
    }
    return results;
  }

  /** 收集 fromTurnIndex 之后所有未回退的 bash mutations。 */
  private _collectLiveBashMutations(
    fromTurnIndex: number,
  ): Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: BashMutation; revertedIndices: number[] }> {
    const log = this.deps.getLog();
    const results: Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: BashMutation; revertedIndices: number[] }> = [];
    for (let li = 0; li < log.length; li++) {
      const entry = log[li]!;
      if (entry.turnIndex < fromTurnIndex) continue;
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (meta.bashMutationReverted) continue;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const bm = toolMeta?.bashMutation as BashMutation | undefined;
      if (!bm) continue;
      const revertedIndices = (meta.bashMutationRevertedIndices as number[]) ?? [];
      results.push({ entryId: entry.id, turnIndex: entry.turnIndex, logIndex: li, mutation: bm, revertedIndices });
    }
    return results;
  }

  /** 构建 bash 回退条目计划（仅包含未回退的条目）。 */
  private _planBashRewindEntries(
    fromTurnIndex: number,
  ): BashRewindEntry[] {
    const collected = this._collectLiveBashMutations(fromTurnIndex);
    const entries: BashRewindEntry[] = [];

    for (let i = collected.length - 1; i >= 0; i--) {
      const { entryId, turnIndex, logIndex, mutation, revertedIndices } = collected[i]!;
      for (let j = mutation.entries.length - 1; j >= 0; j--) {
        if (revertedIndices.includes(j)) continue;
        const me = mutation.entries[j]!;
        const entry = this._classifyBashRewindEntry(entryId, turnIndex, logIndex, j, me);
        entries.push(entry);
      }
    }

    return entries;
  }

  /** 对 bash 回退条目分类（applicable / conflict）。 */
  private _classifyBashRewindEntry(
    entryId: string,
    turnIndex: number,
    logIndex: number,
    bashEntryIndex: number,
    me: BashMutationEntry,
  ): BashRewindEntry {
    const base = { entryId, turnIndex, logIndex, bashEntryIndex, mutation: me };

    // mkdir：检查目录是否仍存在，是否非空
    if (me.kind === "mkdir" && me.createdDirs) {
      const dirs = [...me.createdDirs].reverse();
      const createdSet = new Set(me.createdDirs);
      const desc = `rmdir ${me.createdDirs.join(", ")}`;

      if (!dirs.some(d => existsSync(d))) {
        return { ...base, kind: "mkdir", description: desc, status: "conflict", conflictReason: "dir_deleted", conflictDetails: ["Directories already removed."] };
      }

      // 检查是否非空（排除同一 mkdir 命令创建的兄弟目录）
      const nonEmptyDirs: string[] = [];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
          const contents = readdirSync(dir);
          const external = contents.filter(c => !createdSet.has(join(dir, c)));
          if (external.length > 0) nonEmptyDirs.push(dir);
        } catch { /* ignore */ }
      }

      if (nonEmptyDirs.length > 0) {
        const details: string[] = [];
        for (const dir of nonEmptyDirs) {
          try {
            const files = readdirSync(dir).filter(c => !createdSet.has(join(dir, c))).slice(0, 5);
            details.push(`${dir}: ${files.join(", ")}${files.length >= 5 ? ", ..." : ""}`);
          } catch { details.push(dir); }
        }
        return { ...base, kind: "mkdir", description: desc, status: "conflict", conflictReason: "dir_not_empty", conflictDetails: details };
      }

      return { ...base, kind: "mkdir", description: desc, status: "applicable" };
    }

    // cp：检查目标文件状态和 SHA
    if (me.kind === "cp") {
      if (!me.target) {
        return { ...base, kind: "cp", description: "cp (unknown target)", status: "conflict", conflictReason: "backup_missing" };
      }

      if (!existsSync(me.target)) {
        return { ...base, kind: "cp", description: `rm ${me.target}`, status: "conflict", conflictReason: "target_deleted", conflictDetails: ["Target already removed."] };
      }

      if (me.targetExisted && me.backupPath && !existsSync(me.backupPath)) {
        return { ...base, kind: "cp", description: `restore ${me.target}`, status: "conflict", conflictReason: "backup_missing", conflictDetails: ["Backup file is missing."] };
      }

      if (me.postImageSha) {
        try {
          const currentSha = createHash("sha256").update(readFileSync(me.target)).digest("hex");
          if (currentSha !== me.postImageSha) {
            const desc = me.targetExisted ? `restore ${me.target}` : `rm ${me.target}`;
            return { ...base, kind: "cp", description: desc, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File was modified after the copy."] };
          }
        } catch {
          const desc = me.targetExisted ? `restore ${me.target}` : `rm ${me.target}`;
          return { ...base, kind: "cp", description: desc, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File type changed (cannot read as file)."] };
        }
      }

      const desc = me.targetExisted ? `restore ${me.target} from backup` : `rm ${me.target}`;
      return { ...base, kind: "cp", description: desc, status: "applicable" };
    }

    // mv：检查源文件和目标文件状态
    if (me.kind === "mv") {
      if (!me.source || !me.target) {
        return { ...base, kind: "mv", description: "mv (unknown paths)", status: "conflict", conflictReason: "backup_missing" };
      }

      if (!existsSync(me.target)) {
        return { ...base, kind: "mv", description: `mv ← ${me.source}`, status: "conflict", conflictReason: "target_deleted", conflictDetails: ["Moved file was deleted."] };
      }

      if (existsSync(me.source)) {
        return { ...base, kind: "mv", description: `mv ${me.target} ← ${me.source}`, status: "conflict", conflictReason: "source_occupied", conflictDetails: [`${me.source} already exists.`] };
      }

      if (me.postImageSha) {
        try {
          const currentSha = createHash("sha256").update(readFileSync(me.target)).digest("hex");
          if (currentSha !== me.postImageSha) {
            return { ...base, kind: "mv", description: `mv ${me.target} ← ${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File was modified after the move."] };
          }
        } catch {
          return { ...base, kind: "mv", description: `mv ${me.target} ← ${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File type changed (cannot read as file)."] };
        }
      }

      if (me.targetExisted && me.backupPath && !existsSync(me.backupPath)) {
        return { ...base, kind: "mv", description: `mv ${me.target} ← ${me.source}`, status: "conflict", conflictReason: "backup_missing", conflictDetails: ["Backup of overwritten file is missing."] };
      }

      return { ...base, kind: "mv", description: `mv ${me.target} ← ${me.source}`, status: "applicable" };
    }

    return { ...base, kind: me.kind, description: `${me.kind} (unknown)`, status: "conflict", conflictReason: "backup_missing" };
  }

  private _findLogIndex(entryId: string): number {
    return this.deps.getLog().findIndex(e => e.id === entryId);
  }

  private _isMutationFileCreation(entryId: string): boolean {
    const entry = this.deps.getLog().find(e => e.id === entryId);
    if (!entry) return false;
    const meta = entry.meta as Record<string, unknown>;
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const fm = toolMeta?.fileMutation as FileMutation | undefined;
    return fm?.kind === "created";
  }

  private _markMutationReverted(entryId: string): void {
    const entry = this.deps.getLog().find(e => e.id === entryId);
    if (entry) {
      (entry.meta as Record<string, unknown>).fileMutationReverted = true;
    }
  }

  private _getRewindJournalPath(): string {
    const dir = this.deps.getArtifactsDir() ?? join(homedir(), ".swarmflow", "tmp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, "rewind-journal.json");
  }

  /** 写入回退预镜像 journal（应用前）。 */
  private _writeRewindJournal(plan: RewindPlan): string {
    const journalPath = this._getRewindJournalPath();
    const preimages: Array<{ path: string; existed: boolean; content: string | null }> = [];
    const allPaths = [...plan.applicable, ...plan.warnings];
    for (const entry of allPaths) {
      try {
        const content = readFileSync(entry.path, { encoding: "utf-8" });
        preimages.push({ path: entry.path, existed: true, content });
      } catch {
        preimages.push({ path: entry.path, existed: false, content: null });
      }
    }
    writeFileSync(journalPath, JSON.stringify(preimages), { encoding: "utf-8" });
    return journalPath;
  }

  /** 从 journal 恢复（崩溃时调用）。 */
  private _restoreFromRewindJournal(journalPath: string): void {
    try {
      const raw = readFileSync(journalPath, { encoding: "utf-8" });
      const preimages: Array<{ path: string; existed: boolean; content: string | null }> = JSON.parse(raw);
      for (const img of preimages) {
        try {
          if (img.existed && img.content !== null) {
            writeFileSync(img.path, img.content, { encoding: "utf-8" });
          } else if (!img.existed) {
            try { unlinkSync(img.path); } catch { /* ignore */ }
          }
        } catch { /* best effort */ }
      }
    } catch { /* journal 损坏或缺失 */ }
  }

  private _deleteRewindJournal(journalPath: string): void {
    try { unlinkSync(journalPath); } catch { /* ignore */ }
  }
}
