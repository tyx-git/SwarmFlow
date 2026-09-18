/**
 * GitHub Copilot 模型可见性缓存。
 *
 * Copilot 的 /models 端点会为每个模型返回一个 `policy.state` 字段，
 * 由服务器根据当前用户的套餐和权益计算。对于 Copilot Pro 账号，
 * Pro+ 独占模型（例如 `claude-opus-4.6-fast`）会返回
 * `policy.state: "disabled"`；在 Pro+ 账号上同一模型会返回 `enabled`。
 *
 * 我们在启动时获取一次列表（并在首次使用时惰性获取），将其缓存到
 * 内存 + 磁盘，并暴露 `isModelVisibleForCurrentPlan(modelId)`，
 * 让选择器隐藏用户实际上无法调用的模型。
 *
 * 缓存语义：
 * - 内存缓存存在于进程生命周期内。
 * - 磁盘缓存位于 ~/.swarmflow/copilot-models.json，跨重启保留，
 *   让选择器不必每次启动都等待网络往返。
 * - 获取后 24 小时内视为有效；更旧快照仍会使用（故障安全），
 *   但会触发后台刷新。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { copilotTokenManager } from "../auth/github-copilot-token-manager.js";
import { buildCopilotRequestHeaders } from "./copilot-headers.js";

// =============================================================================
// 常量
// =============================================================================

const CACHE_FILENAME = "copilot-models.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const HTTP_TIMEOUT_MS = 10_000;

// =============================================================================
// 类型
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
// 存储
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
    // 尽力持久化；内存缓存是真实来源。
  }
}

// =============================================================================
// 获取
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
// 缓存管理器
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
 * 强制刷新 Copilot 模型缓存。在登录后调用，也会在
 * `isModelVisibleForCurrentPlan` 发现数据过期时由后台刷新调用。
 * 可安全并发调用 — 共享同一个进行中的 promise。
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
 * 基于缓存的 /models 响应，检查给定 Copilot 模型 ID 是否应对当前用户可见。
 *
 * 以下情况返回 true：
 *   - 没有缓存（乐观：显示它而不是隐藏有效模型）
 *   - 模型列出且 `policy.state === "enabled"`
 *   - 模型完全不在缓存中（对我们尚未见过的新模型做乐观回退）
 *
 * 以下情况返回 false：
 *   - 模型列出且 `policy.state !== "enabled"`（通常是
 *     `"disabled"` → 此账号上的 Pro+ 独占）。
 *
 * 如果缓存过期，会触发后台刷新，但立即返回过期答案以避免阻塞选择器。
 */
export function isModelVisibleForCurrentPlan(modelId: string): boolean {
  const cache = getCached();
  if (!cache) {
    // 启动后台获取，以便下次打开选择器时已有数据。
    void refreshCopilotModelsCache().catch(() => {});
    return true;
  }

  if (isCacheStale(cache)) {
    void refreshCopilotModelsCache().catch(() => {});
    // 继续向下执行并仍使用过期数据。
  }

  const entry = cache.models.find((m) => m.id === modelId);
  // 已填充目录中缺失 = GitHub 不向当前账号/integrator 提供此模型。
  // 选择它会以 model_not_available_for_integrator 返回 400，因此隐藏它。
  //（完全没有缓存时，上面已乐观返回 true，用于离线/首次运行。）
  if (!entry) return false;
  // 只隐藏套餐明确禁用的模型（例如 Pro 账号上的 Pro+ 独占模型）。
  // "enabled" 和 "unconfigured" 都可调用 — "unconfigured" 只表示
  // 未固定组织策略，这是个人账号的默认状态（例如 gpt-5.3-codex）。
  return entry.policy_state !== "disabled";
}

/**
 * 清除缓存（内存 + 磁盘）。登出时调用，确保未来登录从新状态开始，
 * 而不是继承上一个账号的可见性。
 */
export function clearCopilotModelsCache(): void {
  memoryCache = null;
  try {
    const p = cachePath();
    if (existsSync(p)) {
      // 用空 stub 覆盖而不是 unlink（保留 0o600 权限）。
      writeFileSync(p, "", { mode: 0o600 });
    }
  } catch {
    // 忽略
  }
}
