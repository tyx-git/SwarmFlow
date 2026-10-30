/** 文件与 bash 变更追踪：记录可回滚的文件 mutation，解析 mkdir/cp/mv/cd 供文件还原使用。 */

import fs from "node:fs/promises";
import {
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { shell } from "../platform/index.js";

import { createPatch } from "diff";
import { hashFilesystemPath } from "../lib/filesystem-hash.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export interface FileMutation {
  path: string;
  kind: "created" | "modified";
  reversePatch: string | null;
  postImageSha: string;
  additions: number;
  deletions: number;
  untracked?: true;
}

// ------------------------------------------------------------------
// Bash 变更追踪 (mkdir/cp/mv)
// ------------------------------------------------------------------

export interface BashMutationEntry {
  kind: "mkdir" | "cp" | "mv";
  /** mkdir：创建的目录（按创建顺序， 回滚时从最深层开始移除）。 */
  createdDirs?: string[];
  /** cp/mv：源路径。 */
  source?: string;
  /** cp/mv：目标路径。 */
  target?: string;
  /** 操作前目标文件或目录是否存在。 */
  targetExisted?: boolean;
  /** 被覆盖文件或目录的备份路径（在 session artifacts 中）。 */
  backupPath?: string;
  targetKind?: "file" | "directory";
  /** 变更后无法生成可信指纹时，不允许自动回退。 */
  untracked?: true;
  /** cp -r：递归复制创建的新目录树。 */
  recursive?: boolean;
  /** 执行后目标文件或目录树的 SHA256（用于冲突检测）。 */
  postImageSha?: string;
}

export interface BashMutation {
  command: string;
  entries: BashMutationEntry[];
}

// ------------------------------------------------------------------
// Bash 变更追踪：执行前快照 → 执行 → 执行后记录
// ------------------------------------------------------------------

export interface BashPreExecState {
  kind: "mkdir" | "cp" | "mv";
  args: string[];
  /** mkdir -p：执行前已存在的路径段。 */
  existingAncestors?: string[];
  /** cp/mv：解析后的目标路径。 */
  targetPath?: string;
  /** cp/mv：目标之前是否存在。 */
  targetExisted?: boolean;
  targetKind?: "file" | "directory";
  /** cp/mv：备份文件或目录路径（如果目标已存在）。 */
  backupPath?: string;
  /** cp -r 标志。 */
  recursive?: boolean;
  /** cp/mv：源路径。 */
  sourcePath?: string;
}

export const TRACKED_BASH_COMMANDS = new Set(["mkdir", "cp", "mv"]);

export interface TrackableBashParsed {
  cmd: "mkdir" | "cp" | "mv";
  flags: string[];
  args: string[];
}

/**
 * 将 bash 片段解析为可追踪的变更命令。
 * 对不支持的语法（多源、-t 标志、复杂引号等）返回 null。
 * 分类器和追踪器都调用此函数以强制执行契约：
 * 如果返回 null，则该命令无法被准确追踪以用于回滚。
 */
export function parseTrackableBashMutation(segment: string): TrackableBashParsed | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  // 引号感知的分词
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "\\" && !inSingle && i + 1 < trimmed.length) { current += trimmed[i + 1]; i++; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  // 引号未闭合 → 无法可靠解析
  if (inSingle || inDouble) return null;

  if (tokens.length < 2) return null;
  const cmd = (tokens[0]!.split("/").pop() ?? tokens[0]!) as string;
  if (!TRACKED_BASH_COMMANDS.has(cmd)) return null;

  const flags: string[] = [];
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) flags.push(t);
    else args.push(t);
  }

  // 拒绝不支持的 cp/mv 语法
  if (cmd === "cp" || cmd === "mv") {
    // 不支持 -t / --target-directory（包括 -rt 这类合并写法）
    if (flags.some(f => f.startsWith("--target-directory") || (!f.startsWith("--") && f.includes("t")))) return null;
    // 不支持 --parents
    if (flags.some(f => f === "--parents")) return null;
    // 必须正好 2 个位置参数（单源 + 单目标）
    if (args.length !== 2) return null;
  }

  return { cmd: cmd as "mkdir" | "cp" | "mv", flags, args };
}

/**
 * 检查 bash 片段是否是可以准确记录用于回滚的可追踪变更。
 * 由权限分类器使用以强制执行契约：如果不可追踪，
 * 则该命令不得被分类为 write_reversible。
 */
export function isTrackableBashMutation(segment: string): boolean {
  return parseTrackableBashMutation(segment) !== null;
}

export function prepareBashPreExec(
  segment: string,
  backupsDir: string,
  cwd: string,
): BashPreExecState | null {
  const parsed = parseTrackableBashMutation(segment);
  if (!parsed) return null;

  const resolve = (p: string) => path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);

  if (parsed.cmd === "mkdir") {
    const hasDashP = parsed.flags.some(f => f === "-p" || (f.startsWith("-") && f.includes("p") && !f.startsWith("--")));
    const dirs = parsed.args.map(resolve);
    if (hasDashP && dirs.length > 0) {
      const existingAncestors: string[] = [];
      for (const dir of dirs) {
        let current = dir;
        while (current !== path.dirname(current)) {
          if (existsSync(current)) {
            existingAncestors.push(current);
            break;
          }
          current = path.dirname(current);
        }
      }
      return { kind: "mkdir", args: dirs, existingAncestors };
    }
    return { kind: "mkdir", args: dirs };
  }

  if (parsed.cmd === "cp" || parsed.cmd === "mv") {
    // parseTrackableBashMutation 已保证 args.length === 2
    const sourcePath = resolve(parsed.args[0]!);
    if (existsSync(sourcePath)) {
      const sourceStat = lstatSync(sourcePath);
      if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
        throw new Error(`Cannot safely track shell mutation source: ${sourcePath}`);
      }
    }
    let targetPath = resolve(parsed.args[1]!);
    const recursive = parsed.flags.some(f => f === "-r" || f === "-R" || f === "--recursive" ||
      (f.startsWith("-") && !f.startsWith("--") && f.includes("r")));

    // 目标是已存在的目录时，shell 会写到 dir/basename(source)
    if (existsSync(targetPath)) {
      try {
        if (statSync(targetPath).isDirectory()) {
          targetPath = path.join(targetPath, path.basename(sourcePath));
        }
      } catch { /* 忽略 stat 错误 */ }
    }

    let targetExisted = false;
    let targetKind: "file" | "directory" | undefined;
    let backupPath: string | undefined;

    if (existsSync(targetPath)) {
      const targetStat = lstatSync(targetPath);
      if (targetStat.isSymbolicLink() || (!targetStat.isFile() && !targetStat.isDirectory())) {
        throw new Error(`Cannot safely track shell mutation target: ${targetPath}`);
      }
      targetExisted = true;
      targetKind = targetStat.isDirectory() ? "directory" : "file";
      mkdirSync(backupsDir, { recursive: true });
      backupPath = path.join(backupsDir, randomUUID());
      if (targetKind === "directory") cpSync(targetPath, backupPath, { recursive: true, verbatimSymlinks: true });
      else copyFileSync(targetPath, backupPath);
    }

    return {
      kind: parsed.cmd as "cp" | "mv",
      args: [sourcePath, targetPath],
      targetPath,
      targetExisted,
      targetKind,
      backupPath,
      recursive,
      sourcePath,
    };
  }

  return null;
}

export function recordBashPostExec(
  preExec: BashPreExecState,
): BashMutationEntry | null {
  if (preExec.kind === "mkdir") {
    const createdDirs: string[] = [];
    for (const dir of preExec.args) {
      if (!existsSync(dir)) continue;
      if (preExec.existingAncestors) {
        // mkdir -p：从目标向上走，收集所有新建的目录
        let current = dir;
        const newDirs: string[] = [];
        while (current !== path.dirname(current)) {
          if (preExec.existingAncestors.includes(current)) break;
          if (existsSync(current)) newDirs.push(current);
          current = path.dirname(current);
        }
        createdDirs.push(...newDirs.reverse());
      } else {
        if (existsSync(dir)) createdDirs.push(dir);
      }
    }
    if (createdDirs.length === 0) return null;
    return { kind: "mkdir", createdDirs };
  }

  if (preExec.kind === "cp" || preExec.kind === "mv") {
    if (!preExec.targetPath) return null;
    if (!existsSync(preExec.targetPath)) return null;

    let postImageSha: string | undefined;
    try {
      postImageSha = hashFilesystemPath(preExec.targetPath);
    } catch { /* 下面标记为 untracked */ }

    return {
      kind: preExec.kind,
      source: preExec.sourcePath,
      target: preExec.targetPath,
      targetExisted: preExec.targetExisted,
      targetKind: preExec.targetKind,
      backupPath: preExec.backupPath,
      recursive: preExec.recursive || undefined,
      postImageSha,
      ...(!postImageSha ? { untracked: true as const } : {}),
    };
  }

  return null;
}

export function splitCompoundBash(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (ch === "\\" && !inSingle && i + 1 < command.length) { current += ch + command[i + 1]; i++; continue; }
    if (!inSingle && !inDouble) {
      if (ch === "&" && command[i + 1] === "&") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === "|" && command[i + 1] === "|") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === ";") { if (current.trim()) segments.push(current.trim()); current = ""; continue; }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * 从 bash 片段中提取 cd 目标（用于变更追踪）。
 * 内联版本 — 避免导入 cd-context.ts 以防止循环依赖。
 */
export function extractCdTargetForBash(segment: string): string | null {
  const trimmed = segment.trim().replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const parts = trimmed.split(/\s+/);
  if (parts[0] !== "cd") return null;
  if (parts.length === 1) return homedir();
  const target = parts[1]!;
  if (target === "-" || (target.startsWith("$") && target !== "$HOME") || target.includes("`") || target.includes("$(")) return null;
  if (target === "$HOME" || target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));
  return target;
}

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function countDiffLines(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  if (before === "") return { additions: afterLines.length, deletions: 0 };
  if (after === "") return { additions: 0, deletions: beforeLines.length };
  let additions = 0;
  let deletions = 0;
  const beforeSet = new Map<string, number>();
  for (const line of beforeLines) {
    beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  }
  for (const line of afterLines) {
    const count = beforeSet.get(line) ?? 0;
    if (count > 0) {
      beforeSet.set(line, count - 1);
    } else {
      additions++;
    }
  }
  for (const count of beforeSet.values()) {
    deletions += count;
  }
  return { additions, deletions };
}

export function buildFileMutation(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  fileExistedBefore: boolean,
): FileMutation {
  const postImageSha = computeSha256(afterContent);
  const reversePatch = createPatch(filePath, afterContent, beforeContent);
  const { additions, deletions } = countDiffLines(beforeContent, afterContent);
  return {
    path: filePath,
    kind: fileExistedBefore ? "modified" : "created",
    reversePatch,
    postImageSha,
    additions,
    deletions,
  };
}

// ------------------------------------------------------------------
// Bash 安全限制
// ------------------------------------------------------------------
