/** 共享的 gzip JSON 读写（archive 与 sealed sidecar 共用）。 */

import { createWriteStream } from "node:fs";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";

export function writeGzipJson(file: string, value: unknown): void {
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(value))));
}

/** 原子写：tmp + rename；失败清理 tmp，目标文件要么旧版完整、要么新版完整。 */
export function writeGzipJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(value))));
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** 通用 JSONL writer，仅用于非归档数据与迁移输入。 */
export function writeGzipJsonlAtomic(file: string, values: readonly unknown[]): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const body = values.length > 0
      ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
      : "";
    writeFileSync(tmp, gzipSync(Buffer.from(body)));
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export interface GzipJsonlEnvelope<TEntry, TIndex> {
  checkpointId: string;
  entries: TEntry[];
  index: TIndex;
}

interface EnvelopeHeader {
  kind: "header";
  format: "swarmflow-archive";
  version: 1;
  checkpointId: string;
}

interface EnvelopeEntry {
  kind: "entry";
  value: unknown;
}

interface EnvelopeTrailer<TIndex> {
  kind: "trailer";
  index: TIndex;
}

interface ParsedEnvelope<TIndex> {
  checkpointId: string;
  trailerStart: number;
  text: string;
  index: TIndex;
}

function tempPath(file: string): string {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function jsonLine(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Archive envelope records must be JSON serializable.");
  return `${json}\n`;
}

/** 原子流式写归档 envelope，逐条序列化以避免完整归档 JSON 字符串峰值。 */
export async function writeGzipJsonlEnvelopeAtomic<TEntry, TIndex>(
  file: string,
  checkpointId: string,
  entries: Iterable<TEntry>,
  index: TIndex,
): Promise<void> {
  const tmp = tempPath(file);
  const source = Readable.from((function* (): Iterable<string> {
    yield jsonLine({
      kind: "header",
      format: "swarmflow-archive",
      version: 1,
      checkpointId,
    } satisfies EnvelopeHeader);
    for (const entry of entries) yield jsonLine({ kind: "entry", value: entry } satisfies EnvelopeEntry);
    yield jsonLine({ kind: "trailer", index } satisfies EnvelopeTrailer<TIndex>);
  })());

  try {
    await pipeline(source, createGzip(), createWriteStream(tmp));
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** 迁移 CLI 读取旧归档后同步落盘，不参与会话运行时归档。 */
export function writeGzipJsonlEnvelopeAtomicSync<TEntry, TIndex>(
  file: string,
  checkpointId: string,
  entries: Iterable<TEntry>,
  index: TIndex,
): void {
  const tmp = tempPath(file);
  try {
    let body = jsonLine({
      kind: "header",
      format: "swarmflow-archive",
      version: 1,
      checkpointId,
    } satisfies EnvelopeHeader);
    for (const entry of entries) body += jsonLine({ kind: "entry", value: entry } satisfies EnvelopeEntry);
    body += jsonLine({ kind: "trailer", index } satisfies EnvelopeTrailer<TIndex>);
    writeFileSync(tmp, gzipSync(Buffer.from(body)));
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function parseEnvelope<TIndex>(file: string): ParsedEnvelope<TIndex> {
  const text = gunzipSync(readFileSync(file)).toString("utf-8");
  const firstNewline = text.indexOf("\n");
  const lastLineEnd = text.endsWith("\n") ? text.length - 1 : text.length;
  const trailerStart = text.lastIndexOf("\n", lastLineEnd - 1) + 1;
  if (firstNewline < 0 || trailerStart <= firstNewline || lastLineEnd <= trailerStart) {
    throw new Error("Archive envelope is incomplete.");
  }

  const header = JSON.parse(text.slice(0, firstNewline)) as Partial<EnvelopeHeader>;
  if (header.kind !== "header" || header.format !== "swarmflow-archive" || header.version !== 1) {
    throw new Error("Archive envelope header is invalid.");
  }
  if (typeof header.checkpointId !== "string" || header.checkpointId.length === 0) {
    throw new Error("Archive envelope checkpoint id is invalid.");
  }

  const trailer = JSON.parse(text.slice(trailerStart, lastLineEnd)) as Partial<EnvelopeTrailer<TIndex>>;
  if (trailer.kind !== "trailer" || !("index" in trailer)) {
    throw new Error("Archive envelope trailer is invalid.");
  }
  return {
    checkpointId: header.checkpointId,
    trailerStart,
    text,
    index: trailer.index as TIndex,
  };
}

export function readGzipJsonlEnvelopeIndex<TIndex>(file: string): {
  checkpointId: string;
  index: TIndex;
} {
  const { checkpointId, index } = parseEnvelope<TIndex>(file);
  return { checkpointId, index };
}

export function readGzipJsonlEnvelope<TEntry, TIndex>(file: string): GzipJsonlEnvelope<TEntry, TIndex> {
  const { checkpointId, trailerStart, text, index } = parseEnvelope<TIndex>(file);
  const firstNewline = text.indexOf("\n");
  const entriesText = text.slice(firstNewline + 1, trailerStart - 1);
  const entries: TEntry[] = [];
  for (const line of entriesText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Partial<EnvelopeEntry>;
    if (record.kind !== "entry" || !("value" in record)) {
      throw new Error("Archive envelope entry is invalid.");
    }
    entries.push(record.value as TEntry);
  }
  return { checkpointId, entries, index };
}

export function readGzipJson<T>(file: string): T {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf-8")) as T;
}

export function readGzipJsonl<T>(file: string): T[] {
  const text = gunzipSync(readFileSync(file)).toString("utf-8");
  const values: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    values.push(JSON.parse(line) as T);
  }
  return values;
}
