/** 回退引擎：预写日志、崩溃恢复、文件级回退。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  renameSync,
  copyFileSync,
  cpSync,
  readlinkSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

import { applyPatch, parsePatch } from "diff";
import { hashFilesystemPath } from "../../lib/filesystem-hash.js";

import type { FileMutation, BashMutation, BashMutationEntry } from "../../tools/mutations.js";
import type { LogEntry } from "../../context/entry/types.js";
import type {
  RewindPlan,
  RewindApplyResult,
  RewindPathMutation,
  BashRewindEntry,
} from "../../ui/contracts.js";
import { pathsOverlap } from "./paths.js";
import {
  isRewindJournalBackupName,
  rewindJournalBackupDir,
  rewindJournalPath,
} from "./artifacts.js";
import { type RewindAppliedMutation, type RewindEngineDeps, type RewindJournal, type RewindPreimage } from "./types.js";

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
    const journal = this._writeRewindJournal(plan);

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
          const mutationRef = { entryId: be.entryId, bashEntryIndex: be.bashEntryIndex };
          this._beginJournalOperation(journal, [mutationRef]);
          const success = this._executeBashRevert(be);
          if (success) {
            bashReverted.push(be.description);
            this._markBashMutationEntryReverted(be.entryId, be.bashEntryIndex);
            this._recordJournalApplied(journal, mutationRef);
          } else {
            throw new Error(`Failed to revert shell mutation: ${be.description}`);
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
          const mutationRefs = entry.mutations.map((mutation) => ({ entryId: mutation.entryId }));
          this._beginJournalOperation(journal, mutationRefs);
          if (content === "" && createdFile) {
            try {
              unlinkSync(entry.path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          } else {
            writeFileSync(entry.path, content, { encoding: "utf-8" });
          }
          revertedPaths.push(entry.path);

          for (const mutation of entry.mutations) {
            this._markMutationReverted(mutation.entryId);
          }
          for (const mutation of mutationRefs) {
            this._recordJournalApplied(journal, mutation);
          }
        }
      }
    } catch (e) {
      try {
        this._restoreFromRewindJournal(journal);
        this._clearJournalMutationMarks(journal);
        this._deleteRewindJournal(journal);
      } catch (restoreError) {
        return {
          revertedPaths: [],
          conflictPaths: [],
          bashReverted: [],
          bashSkipped: [],
          error: `Rewind failed: ${e instanceof Error ? e.message : String(e)}. Recovery is pending: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        };
      }
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: `Rewind failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (journal.applied.length === 0) this._deleteRewindJournal(journal);

    return { revertedPaths, conflictPaths, bashReverted, bashSkipped };
  }

  /**
   * 检测并从崩溃的回退中恢复（journal 残留时触发）。
   */
  recoverJournalIfNeeded(): boolean {
    const journalPath = this._getRewindJournalPath();
    if (!existsSync(journalPath)) return false;
    const parsed: unknown = JSON.parse(readFileSync(journalPath, { encoding: "utf-8" }));
    if (Array.isArray(parsed)) {
      this._restoreLegacyRewindJournal(parsed);
      unlinkSync(journalPath);
      return true;
    }
    const journal = this._readRewindJournal(journalPath);
    if (journal.state === "preparing") {
      this._deleteRewindJournal(journal);
      return false;
    }
    if (this._journalMatchesPersistedLog(journal)) {
      this._deleteRewindJournal(journal);
      return false;
    }
    this._restoreFromRewindJournal(journal);
    this._clearJournalMutationMarks(journal);
    return true;
  }

  private _restoreLegacyRewindJournal(value: unknown[]): void {
    const preimages = value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Legacy rewind journal contains an invalid preimage.");
      }
      const image = item as Record<string, unknown>;
      if (typeof image.path !== "string" || typeof image.existed !== "boolean") {
        throw new Error("Legacy rewind journal contains an invalid path record.");
      }
      if (image.existed && typeof image.content !== "string") {
        throw new Error(`Legacy rewind journal is missing file content for ${image.path}.`);
      }
      return image as { path: string; existed: boolean; content: string | null };
    });

    for (const image of preimages) {
      if (image.existed && image.content !== null) {
        mkdirSync(dirname(image.path), { recursive: true });
        writeFileSync(image.path, image.content, { encoding: "utf-8" });
      } else if (!image.existed) {
        rmSync(image.path, { recursive: true, force: true });
      }
    }
  }

  /** 调用方确认回退日志已持久化后清理 journal。 */
  finalizeJournal(): void {
    const dir = this.deps.getArtifactsDir();
    if (!dir) return;
    const journalPath = rewindJournalPath(dir);
    if (!existsSync(journalPath)) return;
    this._deleteRewindJournal(this._readRewindJournal(journalPath));
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
          rmSync(me.target, { recursive: true, force: true });
          this._copyBashBackup(me.backupPath, me.target);
          rmSync(me.backupPath, { recursive: true, force: true });
        } else if (existsSync(me.target)) {
          rmSync(me.target, { recursive: true, force: true });
        }
        return true;
      }

      if (me.kind === "mv") {
        if (!me.source || !me.target) return false;
        renameSync(me.target, me.source);
        if (me.targetExisted && me.backupPath) {
          this._copyBashBackup(me.backupPath, me.target);
          rmSync(me.backupPath, { recursive: true, force: true });
        }
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private _copyBashBackup(source: string, target: string): void {
    const stat = lstatSync(source);
    if (stat.isDirectory()) cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    else if (stat.isFile()) copyFileSync(source, target);
    else throw new Error(`Unsupported rewind backup type: ${source}`);
  }

  /** 将指定的 bash mutation 条目标记为已回退。 */
  private _markBashMutationEntryReverted(entryId: string, bashEntryIndex: number): void {
    const entry = this.deps.getLog().find(e => e.id === entryId);
    if (!entry) return;
    const meta = entry.meta as Record<string, unknown>;
    const indices = [...((meta.bashMutationRevertedIndices as number[]) ?? [])];
    if (!indices.includes(bashEntryIndex)) indices.push(bashEntryIndex);

    // 若所有条目都已回退，同时设置遗留标志
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const bm = toolMeta?.bashMutation as BashMutation | undefined;
    const allReverted = Boolean(bm && indices.length >= bm.entries.length);
    this.deps.patchFlags([entryId], {
      bashMutationRevertedIndices: indices,
      ...(allReverted ? { bashMutationReverted: true } : {}),
    });
  }

  /** 读取条目 meta；已归档条目用归档值兜底，运行时标记（已回退等）优先。 */
  private _entryMeta(entry: LogEntry): Record<string, unknown> {
    const live = entry.meta as Record<string, unknown>;
    const archived = this.deps.getArchivedMeta?.(entry.id);
    if (!archived) return live;
    return Object.keys(live).length > 0 ? { ...archived, ...live } : archived;
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
      const meta = this._entryMeta(entry);
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
      const meta = this._entryMeta(entry);
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

    if (me.untracked) {
      return { ...base, kind: me.kind, description: `${me.kind} ${me.target ?? ""}`.trim(), status: "conflict", conflictReason: "untracked", conflictDetails: ["A reliable post-mutation snapshot was not recorded."] };
    }

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
          const currentSha = hashFilesystemPath(me.target);
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
          const currentSha = hashFilesystemPath(me.target);
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
    const meta = this._entryMeta(entry);
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const fm = toolMeta?.fileMutation as FileMutation | undefined;
    return fm?.kind === "created";
  }

  private _markMutationReverted(entryId: string): void {
    this.deps.patchFlags([entryId], { fileMutationReverted: true });
  }

  private _getRewindJournalPath(): string {
    const dir = this.deps.getArtifactsDir();
    if (!dir) throw new Error("Session artifacts are unavailable; refusing an unjournaled rewind.");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return rewindJournalPath(dir);
  }

  /** 为文件和 shell 回退将要触碰的路径建立崩溃恢复快照。 */
  private _writeRewindJournal(plan: RewindPlan): RewindJournal {
    const journalPath = this._getRewindJournalPath();
    if (existsSync(journalPath)) {
      throw new Error("A previous rewind journal still needs recovery; resume the session before retrying.");
    }

    const backupDir = rewindJournalBackupDir(journalPath, randomUUID());
    const journal: RewindJournal = {
      version: 1,
      filePath: journalPath,
      state: "preparing",
      backupDir,
      preimages: [],
      applied: [],
      pending: [],
    };
    mkdirSync(backupDir, { recursive: true });

    try {
      this._writeJournalFile(journalPath, journal);
      const paths = new Set<string>();
      for (const entry of [...plan.applicable, ...plan.warnings]) paths.add(entry.path);
      for (const entry of plan.bashEntries) {
        const mutation = entry.mutation;
        if (mutation.kind === "mkdir") {
          for (const dir of mutation.createdDirs ?? []) paths.add(dir);
        } else {
          if (mutation.source) paths.add(mutation.source);
          if (mutation.target) paths.add(mutation.target);
          if (mutation.backupPath) paths.add(mutation.backupPath);
        }
      }

      let index = 0;
      for (const requestedPath of paths) {
        const targetPath = resolve(requestedPath);
        if (pathsOverlap(targetPath, backupDir) || pathsOverlap(targetPath, journalPath)) {
          throw new Error(`Cannot journal a rewind target that overlaps its recovery data: ${targetPath}`);
        }

        const backupPath = join(backupDir, String(index++));
        let stat;
        try {
          stat = lstatSync(targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            journal.preimages.push({ path: targetPath, kind: "missing" });
            this._writeJournalFile(journalPath, journal);
            continue;
          }
          throw error;
        }

        if (stat.isSymbolicLink()) {
          const symlinkTarget = readlinkSync(targetPath);
          let symlinkType: "file" | "dir" = "file";
          try {
            if (statSync(targetPath).isDirectory()) symlinkType = "dir";
          } catch { /* preserve dangling links as file links */ }
          journal.preimages.push({ path: targetPath, kind: "symlink", symlinkTarget, symlinkType });
        } else if (stat.isFile()) {
          copyFileSync(targetPath, backupPath);
          journal.preimages.push({ path: targetPath, kind: "file", backupPath });
        } else if (stat.isDirectory()) {
          cpSync(targetPath, backupPath, { recursive: true, verbatimSymlinks: true });
          journal.preimages.push({ path: targetPath, kind: "directory", backupPath });
        } else {
          throw new Error(`Cannot safely snapshot special filesystem path: ${targetPath}`);
        }
        this._writeJournalFile(journalPath, journal);
      }

      journal.state = "ready";
      this._writeJournalFile(journalPath, journal);
      return journal;
    } catch (error) {
      this._deleteRewindJournal(journal);
      throw error;
    }
  }

  private _writeJournalFile(path: string, journal: RewindJournal): void {
    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(journal), { encoding: "utf-8" });
      renameSync(tempPath, path);
    } catch (error) {
      try { unlinkSync(tempPath); } catch { /* ignore */ }
      throw error;
    }
  }

  private _readRewindJournal(path: string): RewindJournal {
    const raw = JSON.parse(readFileSync(path, { encoding: "utf-8" })) as Partial<RewindJournal>;
    if (
      raw.version !== 1 ||
      raw.filePath !== path ||
      (raw.state !== "preparing" && raw.state !== "ready") ||
      typeof raw.backupDir !== "string" ||
      !Array.isArray(raw.preimages) ||
      !Array.isArray(raw.applied) ||
      !Array.isArray(raw.pending)
    ) {
      throw new Error("Rewind recovery journal is invalid; it was preserved for manual recovery.");
    }
    const backupDir = resolve(raw.backupDir);
    if (
      dirname(backupDir) !== dirname(resolve(path)) ||
      !isRewindJournalBackupName(basename(backupDir)) ||
      !raw.preimages.every((image) => this._isValidJournalPreimage(image, backupDir)) ||
      !raw.applied.every((item) => this._isValidJournalMutation(item)) ||
      !raw.pending.every((item) => this._isValidJournalMutation(item))
    ) {
      throw new Error("Rewind recovery journal contains invalid paths or mutation references; it was preserved.");
    }
    return raw as RewindJournal;
  }

  private _isValidJournalPreimage(value: unknown, backupDir: string): value is RewindPreimage {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const image = value as Record<string, unknown>;
    if (typeof image.path !== "string" || resolve(image.path) !== image.path) return false;
    if (image.kind === "missing") return true;
    if (image.kind === "symlink") {
      return typeof image.symlinkTarget === "string" &&
        (image.symlinkType === "file" || image.symlinkType === "dir");
    }
    if (image.kind !== "file" && image.kind !== "directory") return false;
    if (typeof image.backupPath !== "string") return false;
    const relativeBackup = relative(backupDir, resolve(image.backupPath));
    return relativeBackup !== "" && relativeBackup !== ".." &&
      !relativeBackup.startsWith(`..${sep}`) && !isAbsolute(relativeBackup);
  }

  private _isValidJournalMutation(value: unknown): value is RewindAppliedMutation {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const mutation = value as Record<string, unknown>;
    return typeof mutation.entryId === "string" && mutation.entryId.length > 0 &&
      (mutation.bashEntryIndex === undefined ||
        (typeof mutation.bashEntryIndex === "number" && Number.isInteger(mutation.bashEntryIndex) && mutation.bashEntryIndex >= 0));
  }

  private _recordJournalApplied(journal: RewindJournal, mutation: RewindAppliedMutation): void {
    const exists = journal.applied.some((item) =>
      item.entryId === mutation.entryId && item.bashEntryIndex === mutation.bashEntryIndex,
    );
    if (exists) return;
    journal.applied.push(mutation);
    journal.pending = journal.pending.filter((item) =>
      item.entryId !== mutation.entryId || item.bashEntryIndex !== mutation.bashEntryIndex,
    );
    this._writeJournalFile(journal.filePath, journal);
  }

  private _beginJournalOperation(journal: RewindJournal, mutations: RewindAppliedMutation[]): void {
    for (const mutation of mutations) {
      if (!journal.pending.some((item) =>
        item.entryId === mutation.entryId && item.bashEntryIndex === mutation.bashEntryIndex,
      )) journal.pending.push(mutation);
    }
    this._writeJournalFile(journal.filePath, journal);
  }

  private _journalMatchesPersistedLog(journal: RewindJournal): boolean {
    const committed = [...journal.applied, ...journal.pending];
    return committed.every((mutation) => {
      const entry = this.deps.getLog().find((candidate) => candidate.id === mutation.entryId);
      if (!entry) return true;
      const meta = entry.meta as Record<string, unknown>;
      if (mutation.bashEntryIndex === undefined) return meta.fileMutationReverted === true;
      if (meta.bashMutationReverted === true) return true;
      const indices = meta.bashMutationRevertedIndices;
      return Array.isArray(indices) && indices.includes(mutation.bashEntryIndex);
    });
  }

  private _restoreFromRewindJournal(journal: RewindJournal): void {
    if (journal.state === "preparing") return;
    const deepestFirst = [...journal.preimages].sort((a, b) => b.path.length - a.path.length);
    for (const image of deepestFirst) {
      rmSync(image.path, { recursive: true, force: true });
    }

    const shallowestFirst = [...journal.preimages].sort((a, b) => a.path.length - b.path.length);
    for (const image of shallowestFirst) {
      if (image.kind === "missing") continue;
      mkdirSync(dirname(image.path), { recursive: true });
      if (image.kind === "symlink") {
        if (!image.symlinkTarget) throw new Error(`Missing symlink target in rewind journal for ${image.path}`);
        symlinkSync(image.symlinkTarget, image.path, image.symlinkType);
      } else {
        if (!image.backupPath || !existsSync(image.backupPath)) {
          throw new Error(`Missing rewind snapshot for ${image.path}`);
        }
        if (image.kind === "file") copyFileSync(image.backupPath, image.path);
        else cpSync(image.backupPath, image.path, { recursive: true, verbatimSymlinks: true });
      }
    }
  }

  private _clearJournalMutationMarks(journal: RewindJournal): void {
    for (const mutation of [...journal.applied, ...journal.pending]) {
      const entry = this.deps.getLog().find((candidate) => candidate.id === mutation.entryId);
      if (!entry) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (mutation.bashEntryIndex === undefined) {
        this.deps.patchFlags([entry.id], { fileMutationReverted: false });
        continue;
      }
      const indices = Array.isArray(meta.bashMutationRevertedIndices)
        ? (meta.bashMutationRevertedIndices as number[]).filter((value) => value !== mutation.bashEntryIndex)
        : [];
      this.deps.patchFlags([entry.id], {
        bashMutationRevertedIndices: indices,
        bashMutationReverted: false,
      });
    }
  }

  private _deleteRewindJournal(journal: RewindJournal): void {
    const journalPath = journal.filePath;
    try { unlinkSync(journalPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    rmSync(journal.backupDir, { recursive: true, force: true });
  }
}
