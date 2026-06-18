/**
 * RewindEngine 鈥?file/bash rewind planning and application.
 *
 * Extracted from Session (P2.1): owns reverse-patch planning, bash-operation
 * revert classification/execution, and the crash-recovery journal. It reads
 * the session log and mutates entry meta (revert markers), but never touches
 * turn/session state 鈥?guards and change notifications stay with Session.
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
  /** Live log array 鈥?the engine reads entries and mutates their meta (revert markers). */
  getLog(): readonly LogEntry[];
  projectRoot: string;
  /** Session artifacts dir when storage is bound (journal location). */
  getArtifactsDir(): string | undefined;
}

export class RewindEngine {
  constructor(private readonly deps: RewindEngineDeps) {}

  /**
   * Build a rewind plan: collect live file mutations from `fromTurnIndex`
   * onward, group by path, and classify each as applicable/warning/conflict.
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
      // Sort newest first 鈥?reverse patches apply in this order
      muts.sort((a, b) => b.turnIndex - a.turnIndex || mutations.indexOf(b) - mutations.indexOf(a));

      // Check for untracked mutations
      if (muts.some(m => m.mutation.untracked || !m.mutation.reversePatch)) {
        conflicts.push({ path: filePath, reason: "untracked" });
        continue;
      }

      // Read current disk state
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

      // Try applying the reverse patch chain
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

      // Count line additions/deletions from the patches
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
      // Reverse: what the forward edit added becomes what revert deletes
      totalAdditions += pathAdd;
      totalDeletions += pathDel;
      fileLineCounts.set(filePath, pathAdd + pathDel);

      if (isDiskModified) {
        warnings.push({ path: filePath, reason: "disk_modified", mutations: pathMutations });
      } else {
        applicable.push({ path: filePath, mutations: pathMutations });
      }
    }

    // Summary file: the one with the most changed lines
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
   * Apply reverse patches and mark mutations as reverted. Does not touch the
   * conversation log structure; the caller owns guards (no in-flight turn)
   * and post-apply notifications.
   */
  async applyFiles(plan: RewindPlan): Promise<RewindApplyResult> {
    const journalPath = this._writeRewindJournal(plan);

    const revertedPaths: string[] = [];
    const conflictPaths: string[] = [];
    const bashReverted: string[] = [];
    const bashSkipped: string[] = [];

    // Build unified timeline: interleave file and bash operations by log position.
    // File mutation groups use the logIndex of their newest (first) mutation.
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
    // Sort by logIndex descending (newest first)
    ops.sort((a, b) => b.logIndex - a.logIndex);

    try {
      for (const op of ops) {
        if (op.type === "bash") {
          const be = op.be;
          // Re-classify at execution time 鈥?earlier file reverts may have
          // changed disk state, turning a plan-time conflict into applicable.
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
   * Check for and recover from a crashed rewind (journal left behind).
   */
  recoverJournalIfNeeded(): void {
    const journalPath = this._getRewindJournalPath();
    if (!existsSync(journalPath)) return;
    this._restoreFromRewindJournal(journalPath);
    this._deleteRewindJournal(journalPath);
  }

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

  private _markBashMutationEntryReverted(entryId: string, bashEntryIndex: number): void {
    const entry = this.deps.getLog().find(e => e.id === entryId);
    if (!entry) return;
    const meta = entry.meta as Record<string, unknown>;
    const indices = (meta.bashMutationRevertedIndices as number[]) ?? [];
    if (!indices.includes(bashEntryIndex)) indices.push(bashEntryIndex);
    meta.bashMutationRevertedIndices = indices;

    // If all entries reverted, set the legacy flag too
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const bm = toolMeta?.bashMutation as BashMutation | undefined;
    if (bm && indices.length >= bm.entries.length) {
      meta.bashMutationReverted = true;
    }
  }

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

  private _classifyBashRewindEntry(
    entryId: string,
    turnIndex: number,
    logIndex: number,
    bashEntryIndex: number,
    me: BashMutationEntry,
  ): BashRewindEntry {
    const base = { entryId, turnIndex, logIndex, bashEntryIndex, mutation: me };

    if (me.kind === "mkdir" && me.createdDirs) {
      const dirs = [...me.createdDirs].reverse();
      const createdSet = new Set(me.createdDirs);
      const desc = `rmdir ${me.createdDirs.join(", ")}`;

      if (!dirs.some(d => existsSync(d))) {
        return { ...base, kind: "mkdir", description: desc, status: "conflict", conflictReason: "dir_deleted", conflictDetails: ["Directories already removed."] };
      }

      // Check emptiness, ignoring sibling dirs from the same mkdir command
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

    if (me.kind === "mv") {
      if (!me.source || !me.target) {
        return { ...base, kind: "mv", description: "mv (unknown paths)", status: "conflict", conflictReason: "backup_missing" };
      }

      if (!existsSync(me.target)) {
        return { ...base, kind: "mv", description: `mv 鈫?${me.source}`, status: "conflict", conflictReason: "target_deleted", conflictDetails: ["Moved file was deleted."] };
      }

      if (existsSync(me.source)) {
        return { ...base, kind: "mv", description: `mv ${me.target} 鈫?${me.source}`, status: "conflict", conflictReason: "source_occupied", conflictDetails: [`${me.source} already exists.`] };
      }

      if (me.postImageSha) {
        try {
          const currentSha = createHash("sha256").update(readFileSync(me.target)).digest("hex");
          if (currentSha !== me.postImageSha) {
            return { ...base, kind: "mv", description: `mv ${me.target} 鈫?${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File was modified after the move."] };
          }
        } catch {
          return { ...base, kind: "mv", description: `mv ${me.target} 鈫?${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File type changed (cannot read as file)."] };
        }
      }

      if (me.targetExisted && me.backupPath && !existsSync(me.backupPath)) {
        return { ...base, kind: "mv", description: `mv ${me.target} 鈫?${me.source}`, status: "conflict", conflictReason: "backup_missing", conflictDetails: ["Backup of overwritten file is missing."] };
      }

      return { ...base, kind: "mv", description: `mv ${me.target} 鈫?${me.source}`, status: "applicable" };
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
    } catch { /* journal corrupt or missing */ }
  }

  private _deleteRewindJournal(journalPath: string): void {
    try { unlinkSync(journalPath); } catch { /* ignore */ }
  }
}
