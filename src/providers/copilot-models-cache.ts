/**
 * GitHub Copilot model visibility cache.
 *
 * Copilot's /models endpoint returns, for each model, a `policy.state` field
 * that the server computes from the current user's plan and entitlements.
 * On a Copilot Pro account, models that are exclusive to Pro+ (e.g.
 * `claude-opus-4.6-fast`) come back with `policy.state: "disabled"`. On a
 * Pro+ account the same model comes back `enabled`.
 *
 * We fetch the list once on startup (and lazily on first use), cache it in
 * memory + on disk, and expose `isModelVisibleForCurrentPlan(modelId)` so
 * the picker can hide models that the user can't actually call.
 *
 * Cache semantics:
 * - In-memory cache lives for the process lifetime.
 * - On-disk cache at ~/.swarmflow/copilot-models.json persists across
 *   restarts so the picker doesn't wait on a network round-trip every launch.
 * - Cache is considered valid for 24 hours after fetch; older snapshots are
 *   still used (fail-safe) but a background refresh is triggered.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { copilotTokenManager } from "../auth/github-copilot-token-manager.js";
import { buildCopilotRequestHeaders } from "./copilot-headers.js";

// =============================================================================
// Constants
// =============================================================================

const CACHE_FILENAME = "copilot-models.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const HTTP_TIMEOUT_MS = 10_000;

// =============================================================================
// Types
// =============================================================================

interface CopilotModelEntry {
  id: string;
  policy_state: "enabled" | "disabled" | "unconfigured" | string;
  picker_enabled: boolean;
  tool_calls: boolean;
  type: string;
}

interface CopilotModelsCacheData {
  fetchedAt: number;
  models: CopilotModelEntry[];
}

// =============================================================================
// Storage
// =============================================================================

function cachePath(): string {
  return join(getSwarmflowHomeDir(), "state", CACHE_FILENAME);
}

function loadCacheFromDisk(): CopilotModelsCacheData | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as Partial<CopilotModelsCacheData>;
    if (
      typeof data.fetchedAt !== "number"
      || !Array.isArray(data.models)
    ) {
      return null;
    }
    return { fetchedAt: data.fetchedAt, models: data.models as CopilotModelEntry[] };
  } catch {
    return null;
  }
}

function saveCacheToDisk(data: CopilotModelsCacheData): void {
  try {
    const dir = join(getSwarmflowHomeDir(), "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Best-effort persistence; in-memory cache is the source of truth.
  }
}

// =============================================================================
// Fetch
// =============================================================================

type RawModelResponse = {
  data?: Array<{
    id?: string;
    model_picker_enabled?: boolean;
    policy?: { state?: string };
    capabilities?: {
      type?: string;
      supports?: { tool_calls?: boolean };
    };
  }>;
};

async function fetchModelsFromServer(): Promise<CopilotModelEntry[]> {
  const apiToken = await copilotTokenManager.getToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(`${apiToken.endpointApi}/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken.token}`,
        ...buildCopilotRequestHeaders(),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`Failed to fetch Copilot models list: HTTP ${resp.status}`);
  }

  const raw = (await resp.json()) as RawModelResponse;
  const entries: CopilotModelEntry[] = [];

  for (const m of raw.data ?? []) {
    if (!m.id) continue;
    entries.push({
      id: m.id,
      policy_state: (m.policy?.state as string) ?? "unconfigured",
      picker_enabled: Boolean(m.model_picker_enabled),
      tool_calls: Boolean(m.capabilities?.supports?.tool_calls),
      type: m.capabilities?.type ?? "chat",
    });
  }

  return entries;
}

// =============================================================================
// Cache manager
// =============================================================================

let memoryCache: CopilotModelsCacheData | null = null;
let memoryInflight: Promise<CopilotModelsCacheData> | null = null;

function getCached(): CopilotModelsCacheData | null {
  if (memoryCache) return memoryCache;
  const disk = loadCacheFromDisk();
  if (disk) memoryCache = disk;
  return memoryCache;
}

function isCacheStale(data: CopilotModelsCacheData): boolean {
  return Date.now() - data.fetchedAt > CACHE_TTL_MS;
}

/**
 * Force a refresh of the Copilot models cache. Called after login + from the
 * background refresh when `isModelVisibleForCurrentPlan` notices stale data.
 * Safe to call concurrently 鈥?shares the same in-flight promise.
 */
export async function refreshCopilotModelsCache(): Promise<CopilotModelsCacheData> {
  if (memoryInflight) return memoryInflight;

  memoryInflight = (async () => {
    try {
      const models = await fetchModelsFromServer();
      const data: CopilotModelsCacheData = { fetchedAt: Date.now(), models };
      memoryCache = data;
      saveCacheToDisk(data);
      return data;
    } finally {
      memoryInflight = null;
    }
  })();

  return memoryInflight;
}

/**
 * Check whether a given Copilot model ID should be visible to the current
 * user based on the cached /models response.
 *
 * Returns true when:
 *   - no cache exists (optimistic: show it rather than hide valid models)
 *   - the model is listed with `policy.state === "enabled"`
 *   - the model is not in the cache at all (optimistic fallback for newly
 *     added models we haven't seen yet)
 *
 * Returns false when:
 *   - the model is listed with `policy.state !== "enabled"` (typically
 *     `"disabled"` 鈫?Pro+ exclusive on this account).
 *
 * If the cache is stale, a background refresh is triggered but the stale
 * answer is returned immediately to avoid blocking the picker.
 */
export function isModelVisibleForCurrentPlan(modelId: string): boolean {
  const cache = getCached();
  if (!cache) {
    // Kick off a background fetch so we have data by the next picker open.
    void refreshCopilotModelsCache().catch(() => {});
    return true;
  }

  if (isCacheStale(cache)) {
    void refreshCopilotModelsCache().catch(() => {});
    // Fall through and use the stale data anyway.
  }

  const entry = cache.models.find((m) => m.id === modelId);
  // Absent from a populated catalog = GitHub does not offer this model to the
  // current account/integrator. Selecting it would 400 with
  // model_not_available_for_integrator, so hide it. (When there's no cache at
  // all we already returned true above 鈥?optimistic for offline/first-run.)
  if (!entry) return false;
  // Hide only models the plan explicitly disables (e.g. Pro+-exclusive models
  // on a Pro account). "enabled" and "unconfigured" are both callable 鈥?  // "unconfigured" just means no org policy is pinned, which is the default
  // for individual accounts (e.g. gpt-5.3-codex).
  return entry.policy_state !== "disabled";
}

/**
 * Clear the cache (in-memory + disk). Called on logout so a future login
 * starts fresh rather than inheriting a previous account's visibility.
 */
export function clearCopilotModelsCache(): void {
  memoryCache = null;
  try {
    const p = cachePath();
    if (existsSync(p)) {
      // Overwrite with empty stub rather than unlink (keeps 0o600 perms).
      writeFileSync(p, "", { mode: 0o600 });
    }
  } catch {
    // ignore
  }
}
