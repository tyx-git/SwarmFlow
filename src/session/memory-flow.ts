/**
 * 全局记忆执行：查阅 `~/.swarmflow/MEMORY.md`，或按裸块正文整体复写它。
 *
 * 只有根会话持有 `memory` 工具。路径是常量（`globalMemoryPath`），模型既不能指定
 * 也不能改写目标，因此这里不走 `scopedPath`——工作区外的写会被它直接拒绝，而本
 * 文件要写的正是 home 目录下这一个文件。安全边界来自三点：唯一可写路径、一代
 * `.bak` 备份、以及注入预算之下的容量硬门（超限即拒绝并给出压缩指令）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { payloadBlockBody } from "../blocks/payload-blocks.js";
import { getSwarmflowHomeDir } from "../config/home-dir.js";
import { globalMemoryPath } from "../prompts/assembler.js";
import { ToolResult } from "../providers/response.js";
import { atomicWriteTextFile, withFileWriteLock } from "../tools/file-write.js";
import { expectArgsObject } from "../tools/arg-validation.js";

/** 行数、单行长度与总字节上限：3 KiB 远小于注入端 8 KiB 预算，规则不会被静默截断。 */
export const MEMORY_MAX_LINES = 40;
export const MEMORY_MAX_LINE_CHARS = 120;
export const MEMORY_MAX_BYTES = 3072;

const READ_HINT =
  "Call memory with no arguments to read it, or put the complete new file between " +
  "'*** Begin Memory' and '*** End Memory' to rewrite it.";

function countNonEmptyLines(body: string): string[] {
  return body.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * 容量硬门：越界即返回可执行的压缩指令，不写任何字节。
 * 单行超长会指名行号，避免模型只知道"太长了"却找不到改哪。
 */
function validateMemoryBody(body: string): string | null {
  const lines = countNonEmptyLines(body);
  if (lines.length > MEMORY_MAX_LINES) {
    return (
      `ERROR: global memory would hold ${lines.length} rules; the limit is ${MEMORY_MAX_LINES} lines. ` +
      "Merge rules that state the same preference and drop ones that only applied to this session — " +
      "keep one short rule per line."
    );
  }

  const allLines = body.split("\n");
  for (let index = 0; index < allLines.length; index++) {
    const line = allLines[index]!;
    if (line.length > MEMORY_MAX_LINE_CHARS) {
      return (
        `ERROR: line ${index + 1} is ${line.length} characters; every line must stay under ` +
        `${MEMORY_MAX_LINE_CHARS}. Rewrite it as one clause, or split it into two rules.`
      );
    }
  }

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MEMORY_MAX_BYTES) {
    return (
      `ERROR: global memory is ${bytes} bytes; the limit is ${MEMORY_MAX_BYTES} so it is never ` +
      "truncated when injected into the system prompt. Shorten the rules until they fit."
    );
  }

  return null;
}

function describeRead(memoryPath: string, content: string, exists: boolean): ToolResult {
  const lines = countNonEmptyLines(content).length;
  const header = `Global memory: ${memoryPath}\nRules: ${lines} / ${MEMORY_MAX_LINES} lines`;
  if (!exists) {
    return new ToolResult({ content: `${header}\n(file does not exist yet — rewrite it to create it)` });
  }
  if (lines === 0) {
    return new ToolResult({ content: `${header}\n(empty; no rules stored yet)` });
  }
  return new ToolResult({ content: `${header}\n\n${content}` });
}

/**
 * `memory` 执行器：无正文 = 只读；有正文 = 整文件复写。
 *
 * 复写是替换而非追加——模型必须把想保留的规则一起抄进新正文，这是"一代备份"
 * 存在的唯一理由。
 */
export async function execMemory(
  args: Record<string, unknown>,
  toolPayload: string | undefined,
  homeDir: string = getSwarmflowHomeDir(),
): Promise<ToolResult> {
  let normalized: Record<string, unknown>;
  try {
    normalized = expectArgsObject("memory", args);
  } catch (error) {
    return ToolResult.error(
      `ERROR: invalid arguments for memory: ${error instanceof Error ? error.message : String(error)} ${READ_HINT}`,
    );
  }
  if (Object.keys(normalized).length > 0) {
    return ToolResult.error(
      "ERROR: memory takes no arguments. " + READ_HINT,
    );
  }

  const memoryPath = globalMemoryPath(homeDir);

  if (typeof toolPayload !== "string" || toolPayload.trim().length === 0) {
    const exists = existsSync(memoryPath);
    const content = exists ? readFileSync(memoryPath, "utf-8").trim() : "";
    return describeRead(memoryPath, content, exists);
  }

  const body = payloadBlockBody(toolPayload);
  if (body.length === 0) {
    return ToolResult.error(
      "ERROR: memory received an empty memory body between '*** Begin Memory' and '*** End Memory'. " +
        "Write the complete new file, or call memory with no body to read the current one.",
    );
  }

  const violation = validateMemoryBody(body);
  if (violation) return ToolResult.error(violation);

  const content = `${body}\n`;
  mkdirSync(dirname(memoryPath), { recursive: true });
  const hadPrevious = existsSync(memoryPath);

  await withFileWriteLock(memoryPath, async () => {
    if (hadPrevious) copyFileSync(memoryPath, `${memoryPath}.bak`);
    await atomicWriteTextFile(memoryPath, content);
  });

  const lines = countNonEmptyLines(body).length;
  const bytes = Buffer.byteLength(content, "utf-8");
  return new ToolResult({
    content:
      `Global memory rewritten: ${memoryPath}\n` +
      `Rules: ${lines} / ${MEMORY_MAX_LINES} lines, ${bytes} / ${MEMORY_MAX_BYTES} bytes\n` +
      `Backup: ${hadPrevious ? `${memoryPath}.bak` : "none (first memory file)"}\n\n` +
      content.trimEnd(),
  });
}
