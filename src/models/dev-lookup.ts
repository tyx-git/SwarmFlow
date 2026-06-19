/**
 * models.dev 规范查找 — 自定义提供者向导的最佳努力能力建议。
 * 给定一个模型 id，从社区 models.dev 目录获取其 context/output/multimodal/
 * thinking，以便 UI 可以预填默认值。
 *
 * 这里的一切都是最佳努力：任何失败（离线、超时、未知模型）
 * 都返回 null，向导回退到手动输入。目录每进程获取一次并缓存到磁盘
 *（24h TTL），因此重复查找是即时的。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { normalizeModelId } from "./config/config.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelSpecSuggestion {
  contextLength?: number;
  maxOutputTokens?: number;
  multimodal?: boolean;
  /** 从 reasoning_options 推断的思考级别（effort/toggle），或 undefined。*/
  thinkingLevels?: string[];
}

interface RawModelEntry {
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
}

let _index: Map<string, ModelSpecSuggestion> | null = null;

function suggestionFrom(m: RawModelEntry): ModelSpecSuggestion {
  const input = m.modalities?.input ?? [];
  const multimodal = input.some((x) => x === "image" || x === "video" || x === "pdf");
  let thinkingLevels: string[] | undefined;
  const ro = m.reasoning_options?.[0];
  if (ro?.type === "effort" && Array.isArray(ro.values) && ro.values.length) {
    thinkingLevels = ro.values;
  } else if (ro?.type === "toggle") {
    thinkingLevels = ["off", "on"];
  } else if (m.reasoning) {
    thinkingLevels = ["on"];
  }
  return {
    contextLength: m.limit?.context,
    maxOutputTokens: m.limit?.output,
    multimodal,
    thinkingLevels,
  };
}

/** 从原始 models.dev api.json 对象构建规范化 id → 建议索引。*/
export function buildModelsDevIndex(api: unknown): Map<string, ModelSpecSuggestion> {
  const index = new Map<string, ModelSpecSuggestion>();
  if (!api || typeof api !== "object") return index;
  for (const provider of Object.values(api as Record<string, { models?: Record<string, RawModelEntry> }>)) {
    for (const [mid, m] of Object.entries(provider?.models ?? {})) {
      const key = normalizeModelId(mid).toLowerCase();
      const s = suggestionFrom(m);
      const existing = index.get(key);
      // Prefer an entry that actually carries a context length.
      if (!existing || (existing.contextLength === undefined && s.contextLength !== undefined)) {
        index.set(key, s);
      }
    }
  }
  return index;
}

function cachePath(homeDir: string): string {
  return join(homeDir, "cache", "models-dev.json");
}

function readDiskCache(homeDir: string): unknown | null {
  try {
    const raw = readFileSync(cachePath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as { fetchedAt?: number; api?: unknown };
    if (typeof parsed.fetchedAt === "number" && Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
      return parsed.api ?? null;
    }
  } catch { /* 无/过期/损坏的缓存 */ }
  return null;
}

function writeDiskCache(homeDir: string, api: unknown): void {
  try {
    const dir = join(homeDir, "cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(homeDir), JSON.stringify({ fetchedAt: Date.now(), api }));
  } catch { /* 最佳努力 */ }
}

async function ensureIndex(opts?: { homeDir?: string; timeoutMs?: number }): Promise<Map<string, ModelSpecSuggestion>> {
  if (_index) return _index;
  const homeDir = opts?.homeDir ?? getSwarmflowHomeDir();

  const cached = readDiskCache(homeDir);
  if (cached) {
    _index = buildModelsDevIndex(cached);
    return _index;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const api = await res.json();
    writeDiskCache(homeDir, api);
    _index = buildModelsDevIndex(api);
    return _index;
  } catch {
    _index = new Map(); // 记住此进程的失败；不要在每次查找时重新获取
    return _index;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 最佳努力获取模型 id 的规范建议。如果 models.dev 无法访问
 * 或不知道该模型，则返回 null。永不抛出。
 */
export async function fetchModelSpecSuggestion(
  modelId: string,
  opts?: { homeDir?: string; timeoutMs?: number },
): Promise<ModelSpecSuggestion | null> {
  if (!modelId?.trim()) return null;
  try {
    const index = await ensureIndex(opts);
    return index.get(normalizeModelId(modelId).toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** 测试/维护钩子：删除进程内缓存。*/
export function _resetModelsDevCache(): void {
  _index = null;
}
