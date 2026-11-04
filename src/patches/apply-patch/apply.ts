/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/lib.rs
 * Modified for SwarmFlow: TypeScript port; filesystem access is injected,
 * and writes are performed sequentially exactly like the upstream CLI.
 */

import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { deriveNewContentsFromChunks } from "./file-update.js";
import type { Hunk } from "./parser.js";

export interface PatchIo {
  /** 读取文本；文件不存在返回 null。 */
  readText(path: string): Promise<string | null>;
  /** 写入文本；实现方负责创建缺失的父目录。 */
  writeText(path: string, content: string): Promise<void>;
  /** 删除单个文件；目录必须报错。 */
  remove(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

export interface ApplyHunksOptions {
  cwd: string;
  io: PatchIo;
  /** 把补丁里的路径映射为实际写入路径；默认相对 cwd 解析。 */
  resolvePath?: (patchPath: string) => string;
}

export interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

export type AppliedPatchFileChange =
  | { kind: "add"; content: string; overwrittenContent: string | null }
  | { kind: "delete"; content: string }
  | {
      kind: "update";
      movePath: string | null;
      oldContent: string;
      overwrittenMoveContent: string | null;
      newContent: string;
    };

export interface AppliedPatchChange {
  path: string;
  change: AppliedPatchFileChange;
}

export interface AppliedPatchDelta {
  changes: AppliedPatchChange[];
}

export class ApplyPatchFailure extends Error {
  readonly delta: AppliedPatchDelta;

  constructor(message: string, delta: AppliedPatchDelta) {
    super(message);
    this.name = "ApplyPatchFailure";
    this.delta = delta;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createNodePatchIo(): PatchIo {
  return {
    async readText(path: string): Promise<string | null> {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async writeText(path: string, content: string): Promise<void> {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    },
    async remove(path: string): Promise<void> {
      unlinkSync(path);
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return statSync(path).isDirectory();
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}

export function formatSummary(affected: AffectedPaths): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of affected.added) lines.push(`A ${path}`);
  for (const path of affected.modified) lines.push(`M ${path}`);
  for (const path of affected.deleted) lines.push(`D ${path}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 按 hunk 顺序应用补丁。跨文件不原子：已成功写入的文件会保留，
 * 失败时抛出的 ApplyPatchFailure.delta 记录这些变更。
 */
export async function applyHunks(
  hunks: readonly Hunk[],
  options: ApplyHunksOptions,
): Promise<{ delta: AppliedPatchDelta; affected: AffectedPaths; summary: string }> {
  const resolvePath = options.resolvePath ?? ((patchPath: string) => resolve(options.cwd, patchPath));
  const affected: AffectedPaths = { added: [], modified: [], deleted: [] };
  const delta: AppliedPatchDelta = { changes: [] };

  if (hunks.length === 0) {
    throw new ApplyPatchFailure("No files were modified.", delta);
  }

  // 与 codex 的 verify 阶段一致：同一路径不能出现在多个 hunk 中。
  const usedPaths = new Set<string>();
  for (const hunk of hunks) {
    const source = resolvePath(hunk.path);
    if (usedPaths.has(source)) {
      throw new ApplyPatchFailure(
        `Invalid patch: multiple operations target ${hunk.path}`,
        delta,
      );
    }
    usedPaths.add(source);
    if (hunk.kind === "update" && hunk.movePath !== null) {
      const destination = resolvePath(hunk.movePath);
      if (usedPaths.has(destination)) {
        throw new ApplyPatchFailure(
          `Invalid patch: multiple operations target ${hunk.movePath}`,
          delta,
        );
      }
      usedPaths.add(destination);
    }
  }

  const fail = (message: string): never => {
    throw new ApplyPatchFailure(message, delta);
  };

  const readOptional = async (path: string, label: string): Promise<string | null> => {
    try {
      return await options.io.readText(path);
    } catch (error) {
      return fail(`${label} ${path}: ${errorText(error)}`);
    }
  };

  for (const hunk of hunks) {
    const path = resolvePath(hunk.path);
    try {
      if (hunk.kind === "add") {
        const overwrittenContent = await readOptional(path, "Failed to read existing file");
        try {
          await options.io.writeText(path, hunk.contents);
        } catch (error) {
          fail(`Failed to write file ${path}: ${errorText(error)}`);
        }
        delta.changes.push({
          path,
          change: { kind: "add", content: hunk.contents, overwrittenContent },
        });
        affected.added.push(hunk.path);
        continue;
      }

      if (hunk.kind === "delete") {
        let isDirectory = false;
        try {
          isDirectory = await options.io.isDirectory(path);
        } catch (error) {
          fail(`Failed to delete file ${path}: ${errorText(error)}`);
        }
        if (isDirectory) {
          fail(`Failed to delete file ${path}: path is a directory`);
        }
        const deletedContent = await readOptional(path, "Failed to read file to delete");
        try {
          await options.io.remove(path);
        } catch (error) {
          fail(`Failed to delete file ${path}: ${errorText(error)}`);
        }
        if (deletedContent !== null) {
          delta.changes.push({
            path,
            change: { kind: "delete", content: deletedContent },
          });
        }
        affected.deleted.push(hunk.path);
        continue;
      }

      let originalContents: string;
      try {
        const text = await options.io.readText(path);
        if (text === null) {
          throw new ApplyPatchFailure(
            `Failed to read file to update ${path}`,
            delta,
          );
        }
        originalContents = text;
      } catch (error) {
        if (error instanceof ApplyPatchFailure) throw error;
        throw new ApplyPatchFailure(
          `Failed to read file to update ${path}: ${errorText(error)}`,
          delta,
        );
      }

      let newContents: string;
      try {
        newContents = deriveNewContentsFromChunks(
          originalContents,
          path,
          hunk.chunks,
        ).newContents;
      } catch (error) {
        throw new ApplyPatchFailure(errorText(error), delta);
      }

      if (hunk.movePath !== null) {
        const destination = resolvePath(hunk.movePath);
        const overwrittenMoveContent = await readOptional(
          destination,
          "Failed to read existing move destination",
        );
        try {
          await options.io.writeText(destination, newContents);
        } catch (error) {
          fail(`Failed to write file ${destination}: ${errorText(error)}`);
        }
        const destinationChangeIndex = delta.changes.length;
        delta.changes.push({
          path: destination,
          change: {
            kind: "add",
            content: newContents,
            overwrittenContent: overwrittenMoveContent,
          },
        });

        let isDirectory = false;
        try {
          isDirectory = await options.io.isDirectory(path);
        } catch (error) {
          fail(`Failed to remove original ${path}: ${errorText(error)}`);
        }
        if (isDirectory) {
          fail(`Failed to remove original ${path}: path is a directory`);
        }
        try {
          await options.io.remove(path);
        } catch (error) {
          fail(`Failed to remove original ${path}: ${errorText(error)}`);
        }
        delta.changes[destinationChangeIndex] = {
          path,
          change: {
            kind: "update",
            movePath: destination,
            oldContent: originalContents,
            overwrittenMoveContent,
            newContent: newContents,
          },
        };
        affected.modified.push(hunk.movePath);
        continue;
      }

      try {
        await options.io.writeText(path, newContents);
      } catch (error) {
        fail(`Failed to write file ${path}: ${errorText(error)}`);
      }
      delta.changes.push({
        path,
        change: {
          kind: "update",
          movePath: null,
          oldContent: originalContents,
          overwrittenMoveContent: null,
          newContent: newContents,
        },
      });
      affected.modified.push(hunk.path);
    } catch (error) {
      if (error instanceof ApplyPatchFailure) throw error;
      throw new ApplyPatchFailure(errorText(error), delta);
    }
  }

  return { delta, affected, summary: formatSummary(affected) };
}
