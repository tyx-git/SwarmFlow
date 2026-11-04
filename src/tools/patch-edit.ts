/** `edit` 工具执行器：解析正文补丁，逐 hunk 顺序写入，并产出展示/变更元数据。 */

import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { ToolResult } from "../providers/response.js";
import {
  ApplyPatchFailure,
  applyHunks,
  computeReplacements,
  formatParseError,
  parsePatch,
  ParseError,
  SourceFile,
  type AppliedPatchChange,
  type AppliedPatchDelta,
  type Hunk,
  type PatchIo,
} from "../patches/apply-patch/index.js";
import { stripDisplayLineCr } from "../lib/line-window.js";
import { withFileWriteLock, atomicWriteTextFile } from "./file-write.js";
import {
  FileVersionConflictError,
  existingFileTooLarge,
  getFileVersionSnapshot,
  sameFileVersion,
  type FileVersionSnapshot,
} from "./file-version.js";
import { scopedPath, toolRoot } from "./path-scoping.js";
import type { ExecuteToolContext } from "./dispatch.js";
import {
  buildDeletedFileMutation,
  buildFileMutation,
  type FileMutation,
} from "./mutations.js";
import {
  buildWriteDisplayData,
  countFileLines,
  inferLanguageByExt,
  type FileModifyDisplayData,
} from "../patches/hunk.js";

export interface PatchFileSummary {
  kind: "A" | "M" | "D";
  path: string;
  from?: string;
}

export interface PatchEditMetadata {
  changedPaths: string[];
  patchFiles: PatchFileSummary[];
  fileModifyDataList: FileModifyDisplayData[];
  fileMutations: FileMutation[];
  fileMutation?: FileMutation;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function binaryMessage(filePath: string): string {
  return `Refusing to edit binary file (contains NUL): ${filePath}`;
}

function tooLargeMessage(message: string): string {
  return message.replace(/^ERROR:\s*/, "");
}

const MAX_DISPLAY_LINES = 2000;

function capDisplayLines(lines: string[]): string[] {
  if (lines.length <= MAX_DISPLAY_LINES) return lines;
  return [
    ...lines.slice(0, MAX_DISPLAY_LINES),
    `... (${lines.length - MAX_DISPLAY_LINES} more lines)`,
  ];
}

function buildDisplayDataForChange(
  hunk: Hunk,
  change: AppliedPatchChange,
): FileModifyDisplayData {
  const detail = change.change;

  if (detail.kind === "add") {
    const data = buildWriteDisplayData(change.path, detail.content, 0);
    if (data.writeLines) data.writeLines = capDisplayLines(data.writeLines);
    return data;
  }

  if (detail.kind === "delete") {
    return {
      filePath: change.path,
      language: inferLanguageByExt(change.path),
      mode: "replace",
      totalLineCount: countFileLines(detail.content),
      hunks: [{
        startLine: 1,
        contextBefore: [],
        deletions: capDisplayLines(SourceFile.parse(detail.content).lineTexts()),
        additions: [],
        contextAfter: [],
      }],
    };
  }

  const originalLines = SourceFile.parse(detail.oldContent).lineTexts();
  let replacements: ReturnType<typeof computeReplacements> = [];
  try {
    replacements = hunk.kind === "update"
      ? computeReplacements(originalLines, hunk.path, hunk.chunks)
      : [[0, originalLines.length, SourceFile.parse(detail.newContent).lineTexts()]];
  } catch {
    replacements = [[0, originalLines.length, SourceFile.parse(detail.newContent).lineTexts()]];
  }

  const displayPath = detail.movePath ?? change.path;
  return {
    filePath: displayPath,
    language: inferLanguageByExt(displayPath),
    mode: "replace",
    totalLineCount: countFileLines(detail.oldContent),
    hunks: replacements.map(([start, oldLength, newLines]) => ({
      startLine: start + 1,
      contextBefore: originalLines.slice(Math.max(0, start - 3), start),
      deletions: originalLines.slice(start, start + oldLength),
      additions: newLines.map(stripDisplayLineCr),
      contextAfter: originalLines.slice(start + oldLength, start + oldLength + 3),
    })),
  };
}

function patchFileForChange(
  hunk: Hunk,
  change: AppliedPatchChange,
): PatchFileSummary {
  const detail = change.change;

  // Move 在“写目标成功、删源失败”时会留下一个 Add change：如实报 A dest，
  // 不能按成功的 M src -> dest 报。
  if (detail.kind === "add") {
    const path = hunk.kind === "update" && hunk.movePath !== null
      ? hunk.movePath
      : hunk.path;
    return { kind: "A", path };
  }
  if (detail.kind === "delete") return { kind: "D", path: hunk.path };
  if (detail.movePath) {
    return {
      kind: "M",
      path: hunk.kind === "update" && hunk.movePath !== null ? hunk.movePath : detail.movePath,
      from: hunk.path,
    };
  }
  return { kind: "M", path: hunk.path };
}

function formatAppliedBeforeFailure(patchFiles: readonly PatchFileSummary[]): string {
  return patchFiles
    .map((file) => (
      file.from ? `${file.kind} ${file.from} -> ${file.path}` : `${file.kind} ${file.path}`
    ))
    .join("\n");
}

function fileMutationsForChange(change: AppliedPatchChange): FileMutation[] {
  const detail = change.change;

  if (detail.kind === "add") {
    return [buildFileMutation(
      change.path,
      detail.overwrittenContent ?? "",
      detail.content,
      detail.overwrittenContent !== null,
    )];
  }

  if (detail.kind === "delete") {
    return [buildDeletedFileMutation(change.path, detail.content)];
  }

  if (detail.movePath) {
    return [
      buildFileMutation(
        detail.movePath,
        detail.overwrittenMoveContent ?? "",
        detail.newContent,
        detail.overwrittenMoveContent !== null,
      ),
      buildDeletedFileMutation(change.path, detail.oldContent),
    ];
  }

  return [buildFileMutation(
    change.path,
    detail.oldContent,
    detail.newContent,
    true,
  )];
}

/** 单次遍历 delta，生成展示卡片、A/M/D 清单、回滚 mutation 与 onFileWrite 路径。 */
function summarizeDelta(
  hunks: readonly Hunk[],
  delta: AppliedPatchDelta,
): PatchEditMetadata {
  const changedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const addChangedPath = (path: string): void => {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    changedPaths.push(path);
  };

  const patchFiles: PatchFileSummary[] = [];
  const fileModifyDataList: FileModifyDisplayData[] = [];
  const fileMutations: FileMutation[] = [];
  const count = Math.min(hunks.length, delta.changes.length);

  for (let index = 0; index < count; index++) {
    const hunk = hunks[index]!;
    const change = delta.changes[index]!;

    addChangedPath(change.path);
    if (change.change.kind === "update" && change.change.movePath) {
      addChangedPath(change.change.movePath);
    }

    patchFiles.push(patchFileForChange(hunk, change));
    fileModifyDataList.push(buildDisplayDataForChange(hunk, change));
    fileMutations.push(...fileMutationsForChange(change));
  }

  return {
    changedPaths,
    patchFiles,
    fileModifyDataList,
    fileMutations,
    ...(fileMutations.length > 0 ? { fileMutation: fileMutations[0] } : {}),
  };
}

/**
 * 执行正文补丁。路径解析与权限在 dispatch/scopedPath 完成；
 * 这里负责读取、逐 hunk 应用、展示数据与失败清单。
 */
export async function toolPatchEdit(
  patch: string,
  ctx: ExecuteToolContext | undefined,
): Promise<ToolResult> {
  let hunks: Hunk[];
  try {
    hunks = parsePatch(patch);
  } catch (error) {
    if (error instanceof ParseError) {
      return new ToolResult({ content: `ERROR: ${formatParseError(error)}` });
    }
    throw error;
  }
  const resolved = new Map<string, string>();
  const snapshots = new Map<string, FileVersionSnapshot>();

  const preparePath = (rawPath: string): string => {
    const existing = resolved.get(rawPath);
    if (existing) return existing;
    // 只做词法作用域检查；文件是否存在、是否为目录留到逐个 hunk 应用时判定，
    // 这样才与 codex 的“前面成功、后面失败”语义一致。
    const absolute = scopedPath(rawPath, "write", ctx, { allowCreate: true });
    resolved.set(rawPath, absolute);
    return absolute;
  };

  for (const hunk of hunks) {
    preparePath(hunk.path);
    if (hunk.kind === "update" && hunk.movePath !== null) {
      preparePath(hunk.movePath);
      if (resolved.get(hunk.movePath) === resolved.get(hunk.path)) {
        return new ToolResult({
          content: `ERROR: Invalid patch: Move target is the same as source: ${hunk.movePath}`,
        });
      }
    }
  }

  const resolvePatchPath = (patchPath: string): string => {
    const absolute = resolved.get(patchPath);
    if (!absolute) throw new Error(`Unresolved patch path: ${patchPath}`);
    return absolute;
  };

  const io: PatchIo = {
    async readText(filePath: string): Promise<string | null> {
      const snapshot = getFileVersionSnapshot(filePath);
      snapshots.set(filePath, snapshot);
      const tooLarge = existingFileTooLarge(snapshot);
      if (tooLarge) throw new Error(tooLargeMessage(tooLarge));
      if (!snapshot.exists) return null;
      const text = readFileSync(filePath, "utf8");
      if (text.includes("\0")) throw new Error(binaryMessage(filePath));
      return text;
    },
    async writeText(filePath: string, content: string): Promise<void> {
      if (content.includes("\0")) throw new Error(binaryMessage(filePath));
      await withFileWriteLock(filePath, async () => {
        mkdirSync(dirname(filePath), { recursive: true });
        const snapshot = snapshots.get(filePath) ?? getFileVersionSnapshot(filePath);
        const tooLarge = existingFileTooLarge(snapshot);
        if (tooLarge) throw new Error(tooLargeMessage(tooLarge));
        await atomicWriteTextFile(
          filePath,
          content,
          snapshot.exists ? snapshot.mode : undefined,
          snapshot,
        );
      });
    },
    async remove(filePath: string): Promise<void> {
      await withFileWriteLock(filePath, async () => {
        const snapshot = snapshots.get(filePath);
        if (snapshot && !sameFileVersion(snapshot, getFileVersionSnapshot(filePath))) {
          throw new FileVersionConflictError(
            `File changed during patch application: ${filePath}. Re-read and retry.`,
          );
        }
        unlinkSync(filePath);
      });
    },
    async isDirectory(filePath: string): Promise<boolean> {
      try {
        return statSync(filePath).isDirectory();
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };

  try {
    const { delta, summary } = await applyHunks(hunks, {
      cwd: toolRoot(ctx),
      io,
      resolvePath: resolvePatchPath,
    });
    const metadata = summarizeDelta(hunks, delta);
    return new ToolResult({
      content: summary.trimEnd(),
      metadata: metadata as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof ApplyPatchFailure) {
      const metadata = summarizeDelta(hunks, error.delta);
      const applied = formatAppliedBeforeFailure(metadata.patchFiles);
      const suffix = applied ? `\nApplied before the failure:\n${applied}` : "";
      return new ToolResult({
        content: `ERROR: ${error.message}${suffix}`,
        metadata: metadata as unknown as Record<string, unknown>,
      });
    }
    throw error;
  }
}
