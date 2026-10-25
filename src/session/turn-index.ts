/**
 * D20：可重建的 turn 索引（`log.index.jsonl`）。
 *
 * 只服务回退菜单：turn 边界/预览/文件变更摘要。权威仍是 `log.jsonl`；
 * 索引带 `source_seq` 校验，日志 seq 不一致时调用方整读重建。
 *
 * 记录格式（每行一条 JSON）：
 *   {"v":1,"op":"header","source_seq":N}
 *   {"v":1,"op":"turn","turn":{...}}
 *   {"v":1,"op":"mutation","mutation":{...}}
 *   {"v":1,"op":"drop-mutation","entryId":"..."}
 *   {"v":1,"op":"revert","entryId":"..."}
 *   {"v":1,"op":"set-revert","entryId":"...","reverted":true|false}
 *   {"v":1,"op":"drop-turn","entryId":"..."}
 *   {"v":1,"op":"drop-turns-from","turnIndex":N}
 *   {"v":1,"op":"checkpoint","source_seq":N}
 */

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ArchivedMutationInfo, ArchivedTurnInfo } from "../config/archive.js";
import type { LogEntry, TurnKind } from "../context/entry/types.js";
import { SessionLog } from "./log.js";

export const TURN_INDEX_FILENAME = "log.index.jsonl";
export const TURN_INDEX_VERSION = 1;

export interface TurnIndexTurn {
  turnIndex: number;
  entryId: string;
  entryIndex: number;
  kind: TurnKind;
  preview: string;
  timestamp: number;
}

export interface TurnIndexMutation {
  entryId: string;
  turnIndex: number;
  path: string;
  additions: number;
  deletions: number;
  reverted: boolean;
}

export interface TurnIndexData {
  turns: TurnIndexTurn[];
  mutations: TurnIndexMutation[];
}

export type TurnIndexOp =
  | { v: typeof TURN_INDEX_VERSION; op: "turn"; turn: TurnIndexTurn }
  | { v: typeof TURN_INDEX_VERSION; op: "mutation"; mutation: TurnIndexMutation }
  | { v: typeof TURN_INDEX_VERSION; op: "drop-mutation"; entryId: string }
  | { v: typeof TURN_INDEX_VERSION; op: "revert"; entryId: string }
  | { v: typeof TURN_INDEX_VERSION; op: "set-revert"; entryId: string; reverted: boolean }
  | { v: typeof TURN_INDEX_VERSION; op: "drop-turn"; entryId: string }
  | { v: typeof TURN_INDEX_VERSION; op: "drop-turns-from"; turnIndex: number };

interface ParsedIndex {
  seq: number;
  data: TurnIndexData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTurn(value: unknown): TurnIndexTurn | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.turnIndex !== "number" || !Number.isInteger(value.turnIndex)
    || typeof value.entryId !== "string" || value.entryId.length === 0
    || typeof value.entryIndex !== "number" || !Number.isInteger(value.entryIndex)
    || typeof value.kind !== "string"
    || typeof value.preview !== "string"
    || typeof value.timestamp !== "number"
  ) return null;
  return {
    turnIndex: value.turnIndex,
    entryId: value.entryId,
    entryIndex: value.entryIndex,
    kind: value.kind as TurnKind,
    preview: value.preview,
    timestamp: value.timestamp,
  };
}

function parseMutation(value: unknown): TurnIndexMutation | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.entryId !== "string" || value.entryId.length === 0
    || typeof value.turnIndex !== "number" || !Number.isInteger(value.turnIndex)
    || typeof value.path !== "string" || value.path.length === 0
    || typeof value.additions !== "number"
    || typeof value.deletions !== "number"
    || typeof value.reverted !== "boolean"
  ) return null;
  return {
    entryId: value.entryId,
    turnIndex: value.turnIndex,
    path: value.path,
    additions: value.additions,
    deletions: value.deletions,
    reverted: value.reverted,
  };
}

function applyOps(parsed: ParsedIndex, lines: readonly string[]): void {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(raw) || raw.v !== TURN_INDEX_VERSION) continue;
    switch (raw.op) {
      case "header":
      case "checkpoint":
        if (typeof raw.source_seq === "number") parsed.seq = raw.source_seq;
        break;
      case "turn": {
        const turn = parseTurn(raw.turn);
        if (turn) {
          parsed.data.turns = [
            ...parsed.data.turns.filter((item) => item.entryId !== turn.entryId),
            turn,
          ];
        }
        break;
      }
      case "mutation": {
        const mutation = parseMutation(raw.mutation);
        if (mutation) {
          parsed.data.mutations = [
            ...parsed.data.mutations.filter((item) => item.entryId !== mutation.entryId),
            mutation,
          ];
        }
        break;
      }
      case "drop-mutation":
        if (typeof raw.entryId === "string") {
          parsed.data.mutations = parsed.data.mutations.filter((item) => item.entryId !== raw.entryId);
        }
        break;
      case "revert":
        if (typeof raw.entryId === "string") {
          parsed.data.mutations = parsed.data.mutations.map((item) =>
            item.entryId === raw.entryId ? { ...item, reverted: true } : item);
        }
        break;
      case "set-revert":
        if (typeof raw.entryId === "string" && typeof raw.reverted === "boolean") {
          parsed.data.mutations = parsed.data.mutations.map((item) =>
            item.entryId === raw.entryId ? { ...item, reverted: raw.reverted as boolean } : item);
        }
        break;
      case "drop-turn": {
        if (typeof raw.entryId !== "string") break;
        const removed = parsed.data.turns.find((turn) => turn.entryId === raw.entryId);
        parsed.data.turns = parsed.data.turns.filter((turn) => turn.entryId !== raw.entryId);
        // 同一 turnIndex 可能还有另一个边界记录（如 input_received + turn_start）；
        // 只有最后一个也移除后，才丢弃该 turn 的 mutation。
        if (removed && !parsed.data.turns.some((turn) => turn.turnIndex === removed.turnIndex)) {
          parsed.data.mutations = parsed.data.mutations.filter(
            (mutation) => mutation.turnIndex !== removed.turnIndex);
        }
        break;
      }
      case "drop-turns-from":
        if (typeof raw.turnIndex === "number" && Number.isInteger(raw.turnIndex)) {
          const cutoff = raw.turnIndex;
          parsed.data.turns = parsed.data.turns.filter((turn) => turn.turnIndex < cutoff);
          parsed.data.mutations = parsed.data.mutations.filter(
            (mutation) => mutation.turnIndex < cutoff);
        }
        break;
      default:
        break;
    }
  }
}

function parseIndexFile(dir: string): ParsedIndex | null {
  const file = join(dir, TURN_INDEX_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const parsed: ParsedIndex = { seq: -1, data: { turns: [], mutations: [] } };
    applyOps(parsed, readFileSync(file, "utf-8").split(/\r?\n/));
    return parsed;
  } catch {
    return null;
  }
}

/** 从完整条目构建索引数据（权威重放路径）。 */
export function buildTurnIndex(
  entries: readonly LogEntry[],
  archivedTurnInfo?: ReadonlyMap<string, ArchivedTurnInfo>,
  archivedMutations?: ReadonlyMap<string, ArchivedMutationInfo>,
): TurnIndexData {
  const log = new SessionLog();
  log.replace(entries as LogEntry[]);
  const turns: TurnIndexTurn[] = log.listTurns(archivedTurnInfo).map((turn) => ({
    turnIndex: turn.turnIndex,
    entryId: entries[turn.entryIndex]?.id ?? "",
    entryIndex: turn.entryIndex,
    kind: turn.turnKind,
    preview: turn.preview,
    timestamp: turn.timestamp,
  }));

  const mutations: TurnIndexMutation[] = [];
  for (const entry of entries) {
    if (entry.type !== "tool_result" || entry.discarded) continue;
    const meta = entry.meta as Record<string, unknown>;
    const toolMeta = meta["toolMetadata"] as Record<string, unknown> | undefined;
    const live = toolMeta?.fileMutation as { path?: unknown; additions?: unknown; deletions?: unknown } | undefined;
    const archived = archivedMutations?.get(entry.id);
    const path = typeof live?.path === "string" ? live.path : archived?.path;
    if (!path) continue;
    mutations.push({
      entryId: entry.id,
      turnIndex: entry.turnIndex,
      path,
      additions: typeof live?.additions === "number" ? live.additions : archived?.additions ?? 0,
      deletions: typeof live?.deletions === "number" ? live.deletions : archived?.deletions ?? 0,
      reverted: meta["fileMutationReverted"] === true,
    });
  }
  return { turns, mutations };
}

/** 原子写一份完整索引。 */
export function writeTurnIndex(dir: string, data: TurnIndexData, sourceSeq: number): void {
  const file = join(dir, TURN_INDEX_FILENAME);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const lines = [
    JSON.stringify({ v: TURN_INDEX_VERSION, op: "header", source_seq: sourceSeq }),
    ...data.turns.map((turn) => JSON.stringify({ v: TURN_INDEX_VERSION, op: "turn", turn })),
    ...data.mutations.map((mutation) => JSON.stringify({ v: TURN_INDEX_VERSION, op: "mutation", mutation })),
    JSON.stringify({ v: TURN_INDEX_VERSION, op: "checkpoint", source_seq: sourceSeq }),
  ];
  writeFileSync(tmp, `${lines.join("\n")}\n`, "utf-8");
  renameSync(tmp, file);
}

/** 读取索引；`source_seq` 与日志不一致时返回 null（调用方应重建）。 */
export function readTurnIndex(dir: string, expectedSeq: number): TurnIndexData | null {
  const parsed = parseIndexFile(dir);
  if (!parsed || parsed.seq !== expectedSeq) return null;
  return parsed.data;
}

/**
 * 增量追加：仅当现有索引的 checkpoint 等于 beforeSeq 时成功。
 * 返回 false 表示索引缺失/过期，调用方下次读取时整读重建。
 */
export function appendTurnIndex(
  dir: string,
  beforeSeq: number,
  ops: readonly TurnIndexOp[],
  nextSeq: number,
): boolean {
  const parsed = parseIndexFile(dir);
  if (!parsed || parsed.seq !== beforeSeq) return false;
  const lines = [
    ...ops.map((op) => JSON.stringify(op)),
    JSON.stringify({ v: TURN_INDEX_VERSION, op: "checkpoint", source_seq: nextSeq }),
  ];
  try {
    appendFileSync(join(dir, TURN_INDEX_FILENAME), `${lines.join("\n")}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 删除索引（快照/截断/补丁后下次读取重建）。 */
export function deleteTurnIndex(dir: string): void {
  try {
    rmSync(join(dir, TURN_INDEX_FILENAME), { force: true });
  } catch {
    // best effort
  }
}
