/**
 * models.dev spec lookup 鈥?best-effort capability suggestions for the custom
 * provider wizard. Given a model id, fetch its context/output/multimodal/
 * thinking from the community models.dev catalog so the UI can pre-fill defaults.
 *
 * Everything here is best-effort: any failure (offline, timeout, unknown model)
 * returns null and the wizard falls back to manual entry. The catalog is fetched
 * once per process and cached on disk (24h TTL) so repeat lookups are instant.
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
  /** Thinking levels inferred from reasoning_options (effort/toggle), or undefined. */
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

/** Build the normalized-id 鈫?suggestion index from a raw models.dev api.json object. */
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
  } catch { /* no/stale/corrupt cache */ }
  return null;
}

function writeDiskCache(homeDir: string, api: unknown): void {
  try {
    const dir = join(homeDir, "cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(homeDir), JSON.stringify({ fetchedAt: Date.now(), api }));
  } catch { /* best-effort */ }
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
    _index = new Map(); // remember the failure for this process; don't refetch per lookup
    return _index;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort spec suggestion for a model id. Returns null if models.dev is
 * unreachable or doesn't know the model. Never throws.
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

/** Test/maintenance hook: drop the in-process cache. */
export function _resetModelsDevCache(): void {
  _index = null;
}
