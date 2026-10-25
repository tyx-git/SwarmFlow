/**
 * W-2 写前策略：只写完成态、截断大工具输出、把图片换成 image_ref。
 *
 * 设计口径见 LOG_WRITE_DESIGN.md §W4.3。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LogEntry } from "../context/entry/types.js";
import { truncateUtf8 } from "../prompts/assembler.js";
import { extractAndSaveImages, type AttachmentContext } from "../session/attachments.js";

/** 单个工具结果/命令输出允许内联到日志的最大字节数。 */
export const PERSISTED_TOOL_OUTPUT_MAX_BYTES = 64 * 1024;

/** 截断后追加在正文末尾的标记。 */
export const TOOL_OUTPUT_TRUNCATION_MARKER =
  "\n... output truncated for persistence; read the full copy with read_file ...\n";

/** 大工具结果的全文目录（相对会话目录）。 */
export const PERSISTED_TOOL_OUTPUT_DIR = "artifacts/agent-outputs";

/** 图片外置目录（相对会话目录）。 */
export const PERSISTED_IMAGES_DIR = "images";

export interface CapPersistedEntryOptions {
  sessionDir: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 该条目是否应该进入追加日志。
 * 规则：ephemeral 不写；流式/运行中的工具状态先不写；其余写。
 */
export function shouldPersistEntry(entry: LogEntry): boolean {
  const meta = entry.meta as Record<string, unknown>;
  if (meta["ephemeral"] === true) return false;
  if (meta["toolStreamState"] === "partial") return false;
  const execState = meta["toolExecState"];
  if (execState === "running" || execState === "not_started") return false;
  return true;
}

function nextImageNumber(sessionDir: string): number {
  const imagesDir = join(sessionDir, PERSISTED_IMAGES_DIR);
  let next = 1;
  if (!existsSync(imagesDir)) return next;
  for (const name of readdirSync(imagesDir)) {
    const match = /^img-(\d+)\./.exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function truncateToolOutput(
  text: string,
  entryId: string,
  sessionDir: string,
): { content: string; relativePath: string } | undefined {
  if (Buffer.byteLength(text, "utf8") <= PERSISTED_TOOL_OUTPUT_MAX_BYTES) return undefined;

  const relativePath = `${PERSISTED_TOOL_OUTPUT_DIR}/${entryId}.txt`;
  const outputDir = join(sessionDir, PERSISTED_TOOL_OUTPUT_DIR);
  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(sessionDir, relativePath), text, "utf-8");
  } catch {
    // 外置失败时保留全文，宁可多写也不能丢工具结果。
    return undefined;
  }

  const truncated = truncateUtf8(text, PERSISTED_TOOL_OUTPUT_MAX_BYTES);
  const pointer = `\n\n[full output: ${relativePath}; continue with read_file]`;
  return { content: `${truncated}${pointer}`, relativePath };
}

/**
 * 落盘前减重：截断超限工具输出、把 base64 图片换成 image_ref。
 * 返回新条目，不修改入参。
 */
export function capPersistedEntry(entry: LogEntry, opts: CapPersistedEntryOptions): LogEntry {
  const cloned: LogEntry = {
    ...entry,
    content: entry.content,
    meta: { ...(entry.meta as Record<string, unknown>) },
  };
  const meta = cloned.meta as Record<string, unknown>;

  const content = entry.content;
  if (isPlainObject(content) && typeof content.content === "string") {
    const truncated = truncateToolOutput(content.content, entry.id, opts.sessionDir);
    if (truncated) {
      cloned.content = { ...content, content: truncated.content };
      meta["persistedOutputPath"] = truncated.relativePath;
    }
  } else if (typeof content === "string") {
    const truncated = truncateToolOutput(content, entry.id, opts.sessionDir);
    if (truncated) {
      cloned.content = truncated.content;
      meta["persistedOutputPath"] = truncated.relativePath;
    }
  }

  const toolMetadata = meta["toolMetadata"];
  if (isPlainObject(toolMetadata) && Array.isArray(toolMetadata["_contentBlocks"])) {
    let nextImage = nextImageNumber(opts.sessionDir);
    const context: AttachmentContext = {
      projectRoot: opts.sessionDir,
      sessionDir: () => opts.sessionDir,
      artifactsDir: () => join(opts.sessionDir, "artifacts"),
      supportsMultimodal: () => true,
      nextImageNumber: () => nextImage++,
    };
    const blocks = extractAndSaveImages(
      context,
      toolMetadata["_contentBlocks"] as Array<Record<string, unknown>>,
    );
    meta["toolMetadata"] = { ...toolMetadata, _contentBlocks: blocks };
  }

  return cloned;
}

/** 持久化统一入口：先判是否该写，再做截断/图片外置。 */
export function prepareEntryForPersistence(
  entry: LogEntry,
  sessionDir: string,
): LogEntry | null {
  if (!shouldPersistEntry(entry)) return null;
  return capPersistedEntry(entry, { sessionDir });
}
