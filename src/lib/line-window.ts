/**
 * 流式文件行窗口读取。
 *
 * read_file 只需要一个行窗口（start/end、tail 或前 1000 行），但还必须知道
 * 总行数用于头部与翻页提示。这里用 readline 逐行消费文件：
 * - 选中行最多 maxLines 条，tail 使用同大小的环形缓冲；
 * - 总行数边读边计数，不把整个文件或全部行数组留在内存里；
 * - 行尾 \r\n 由 readline 统一处理，语义与 text.split(/\r?\n/) 一致。
 *
 * 不用于图片或投影文档；投影文档已经是内存中的文本，走 FromText 入口复用
 * 同一套窗口选择逻辑。
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface LineWindowOptions {
  /** 起始行，从 1 开始。默认 1。 */
  startLine?: number;
  /** 结束行（含）；undefined 或 -1 表示读到 EOF。 */
  endLine?: number;
  /** 尾部窗口；优先于 start/end。 */
  tailLines?: number;
  /** 单次调用的熔断上限；选中行数不会超过它。 */
  maxLines: number;
}

export interface LineWindowResult {
  totalLines: number;
  start: number;
  end: number;
  lines: string[];
  /** 请求的范围在 maxLines 处被截断。 */
  lineCapApplied: boolean;
  /** tailLines 被 maxLines 截断，且文件行数超过 maxLines。 */
  tailCapped: boolean;
}

export class LineWindowError extends Error {}

async function* readFileLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function* arrayLines(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

async function selectLineWindow(
  source: AsyncIterable<string>,
  options: LineWindowOptions,
): Promise<LineWindowResult> {
  const maxLines = Math.max(1, options.maxLines);
  const tailRequested = options.tailLines != null ? Math.max(1, options.tailLines) : undefined;
  const start = options.startLine ?? 1;
  const endArg = options.endLine == null || options.endLine === -1 ? Number.POSITIVE_INFINITY : options.endLine;

  if (tailRequested == null) {
    if (start < 1) throw new LineWindowError(`start_line must be >= 1, got ${start}.`);
    if (endArg !== Number.POSITIVE_INFINITY && endArg < start) {
      throw new LineWindowError(`end_line (${endArg}) < start_line (${start}).`);
    }
  }

  const tailCount = tailRequested != null ? Math.min(tailRequested, maxLines) : 0;
  const collectEnd = tailRequested == null
    ? (endArg === Number.POSITIVE_INFINITY ? start + maxLines - 1 : Math.min(endArg, start + maxLines - 1))
    : 0;

  const tailBuffer: string[] = [];
  const selected: string[] = [];
  let total = 0;

  for await (const line of source) {
    total += 1;
    if (tailRequested != null) {
      tailBuffer.push(line);
      if (tailBuffer.length > tailCount) tailBuffer.shift();
    } else if (total >= start && total <= collectEnd) {
      selected.push(line);
    }
  }

  // 空文件保持 read_file 原有语义：仍以第 1 行作为可读位置。
  if (total === 0) total = 1;

  if (tailRequested != null) {
    return {
      totalLines: total,
      start: tailBuffer.length === 0 ? 1 : Math.max(1, total - tailBuffer.length + 1),
      end: total,
      lines: tailBuffer,
      lineCapApplied: false,
      tailCapped: tailRequested > maxLines && total > maxLines,
    };
  }

  if (start > total) {
    throw new LineWindowError(`start_line ${start} exceeds total lines (${total}).`);
  }
  const actualEnd = endArg === Number.POSITIVE_INFINITY ? total : Math.min(endArg, total);
  const lineCapApplied = actualEnd - start + 1 > maxLines;
  const end = lineCapApplied ? start + maxLines - 1 : actualEnd;
  return {
    totalLines: total,
    start,
    end,
    lines: selected.slice(0, end - start + 1),
    lineCapApplied,
    tailCapped: false,
  };
}

export async function readLineWindowFromFile(
  filePath: string,
  options: LineWindowOptions,
): Promise<LineWindowResult> {
  return selectLineWindow(readFileLines(filePath), options);
}

export async function readLineWindowFromText(
  text: string,
  options: LineWindowOptions,
): Promise<LineWindowResult> {
  const lines = text.split(/\r?\n/);
  // 与 readline 对齐：末尾换行不产生额外空行，但真实的末尾空行会保留。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return selectLineWindow(arrayLines(lines), options);
}
