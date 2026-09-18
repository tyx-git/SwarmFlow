/**
 * OpenAI Codex 用量跟踪 — 获取限速数据并定期轮询。
 *
 * 数据源：GET https://chatgpt.com/backend-api/wham/usage
 * 需要有效 OAuth access token（与 Codex API 调用相同）。
 */

import { EventEmitter } from "node:events";

// ------------------------------------------------------------------
// 类型
// ------------------------------------------------------------------

export interface UsageWindow {
  /** 窗口的人类可读标签，例如 "5h", "Wk", "month"。 */
  label: string;
  /** 剩余额度百分比（0–100）。 */
  remainPercent: number;
  /** 绝对重置时间（epoch 后毫秒），如果可用。 */
  resetAt?: number;
  /** 当提供者暴露离散整数配额时的绝对剩余数量（Copilot）。 */
  absoluteRemaining?: number;
  /** 绝对总权益，与 absoluteRemaining 配对（Copilot）。 */
  absoluteTotal?: number;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan?: string;
  error?: string;
  /** 获取此快照时的时间戳。 */
  fetchedAt: number;
}

// ------------------------------------------------------------------
// 获取
// ------------------------------------------------------------------

/** 用于推断周窗口的 secondary 与 primary 重置之间的最小间隔（秒）。 */
const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

type WhamResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveSecondaryLabel(params: {
  windowHours: number;
  secondaryResetAt?: number;
  primaryResetAt?: number;
}): string {
  if (params.windowHours >= 168) return "Wk";
  if (params.windowHours < 24) return `${params.windowHours}h`;
  if (
    typeof params.secondaryResetAt === "number" &&
    typeof params.primaryResetAt === "number" &&
    params.secondaryResetAt - params.primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return "Wk";
  }
  return "Day";
}

/**
 * 从 ChatGPT 后端获取 Codex 用量。
 * 返回包含限速窗口和可选套餐信息的快照。
 */
export async function fetchCodexUsage(token: string): Promise<UsageSnapshot> {
  const now = Date.now();

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    return {
      windows: [],
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      fetchedAt: now,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { windows: [], error: "token_expired", fetchedAt: now };
  }
  if (!res.ok) {
    return { windows: [], error: `HTTP ${res.status}`, fetchedAt: now };
  }

  let data: WhamResponse;
  try {
    data = (await res.json()) as WhamResponse;
  } catch {
    return { windows: [], error: "invalid JSON", fetchedAt: now };
  }

  const windows: UsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 18000) / 3600);
    windows.push({
      label: `${windowHours}h`,
      remainPercent: clamp(100 - (pw.used_percent || 0), 0, 100),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const windowHours = Math.round((sw.limit_window_seconds || 604800) / 3600);
    const label = resolveSecondaryLabel({
      windowHours,
      primaryResetAt: data.rate_limit?.primary_window?.reset_at,
      secondaryResetAt: sw.reset_at,
    });
    windows.push({
      label,
      remainPercent: clamp(100 - (sw.used_percent || 0), 0, 100),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : parseFloat(String(data.credits.balance)) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return { windows, plan, fetchedAt: now };
}

// ------------------------------------------------------------------
// 格式化辅助函数
// ------------------------------------------------------------------

/**
 * 将重置时间戳格式化为人类可读的剩余时间字符串。
 * 使用 "Xh Ym" / "Xd Yh" / "Xm" 格式。不使用 emoji。
 */
export function formatResetRemaining(resetAtMs?: number, now?: number): string | null {
  if (!resetAtMs) return null;
  const base = now ?? Date.now();
  const diffMs = resetAtMs - base;
  if (diffMs <= 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// ------------------------------------------------------------------
// 轮询器
// ------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface UsagePollerEvents {
  update: [snapshot: UsageSnapshot];
  error: [error: Error];
}

/** 给定某个凭据 token 后获取用量快照的函数。 */
export type UsageFetchFn = (token: string) => Promise<UsageSnapshot>;

export interface UsagePollerOptions {
  /** 快照生产器。为向后兼容默认使用 Codex 获取。 */
  fetchFn?: UsageFetchFn;
  /** 轮询间隔，单位毫秒。默认 60s。 */
  intervalMs?: number;
}

/**
 * 定期轮询配额/用量端点并发出 "update" 事件。
 *
 * 用法：
 *   const poller = new UsagePoller({ fetchFn: fetchCopilotUsage });
 *   poller.on("update", (snapshot) => { ... });
 *   poller.start(token);
 *   // 之后：
 *   poller.stop();
 */
export class UsagePoller extends EventEmitter {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _token: string | null = null;
  private _snapshot: UsageSnapshot | null = null;
  private _intervalMs: number;
  private _fetchFn: UsageFetchFn;

  constructor(opts: UsagePollerOptions | number = {}) {
    super();
    // 向后兼容：构造函数过去只接受 intervalMs 数字。
    if (typeof opts === "number") {
      this._intervalMs = opts;
      this._fetchFn = fetchCodexUsage;
    } else {
      this._intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      this._fetchFn = opts.fetchFn ?? fetchCodexUsage;
    }
  }

  get snapshot(): UsageSnapshot | null {
    return this._snapshot;
  }

  get running(): boolean {
    return this._timer !== null;
  }

  start(token: string): void {
    this.stop();
    this._token = token;
    // 获取 immediately, then on interval.
    void this._poll();
    this._timer = setInterval(() => void this._poll(), this._intervalMs);
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._token = null;
  }

  /** 更新 token 而不重启轮询周期。 */
  updateToken(token: string): void {
    this._token = token;
  }

  private async _poll(): Promise<void> {
    if (!this._token) return;
    try {
      const snapshot = await this._fetchFn(this._token);
      this._snapshot = snapshot;
      this.emit("update", snapshot);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ------------------------------------------------------------------
// Copilot 用量获取（遗留 premium-request 配额 — 仅年度套餐）
// ------------------------------------------------------------------

type CopilotQuotaDetail = {
  entitlement?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_permitted?: boolean;
};

type CopilotUserResponse = {
  copilot_plan?: string;
  access_type_sku?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaDetail;
  };
};

/**
 * 从 api.github.com/copilot_internal/user 获取 GitHub Copilot 用量。
 * 使用长生命周期 GitHub OAuth token 调用，而不是短生命周期 Copilot API token —
 * 此端点位于 api.github.com，而非 api.githubcopilot.com。
 */
export async function fetchCopilotUsage(
  githubToken: string,
): Promise<UsageSnapshot> {
  const now = Date.now();

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    res = await fetch("https://api.github.com/copilot_internal/user", {
      method: "GET",
      headers: {
        authorization: `token ${githubToken}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    return {
      windows: [],
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      fetchedAt: now,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { windows: [], error: "token_expired", fetchedAt: now };
  }
  if (!res.ok) {
    return { windows: [], error: `HTTP ${res.status}`, fetchedAt: now };
  }

  let data: CopilotUserResponse;
  try {
    data = (await res.json()) as CopilotUserResponse;
  } catch {
    return { windows: [], error: "invalid JSON", fetchedAt: now };
  }

  const premium = data.quota_snapshots?.premium_interactions;
  const windows: UsageWindow[] = [];

  if (premium) {
    const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : 0;
    const remaining = typeof premium.remaining === "number" ? premium.remaining : 0;
    const pctRemaining =
      typeof premium.percent_remaining === "number"
        ? clamp(premium.percent_remaining, 0, 100)
        : entitlement > 0
          ? clamp((remaining / entitlement) * 100, 0, 100)
          : 100;

    const resetMs = data.quota_reset_date_utc
      ? Date.parse(data.quota_reset_date_utc)
      : undefined;

    windows.push({
      label: "month",
      remainPercent: pctRemaining,
      resetAt: Number.isFinite(resetMs) ? resetMs : undefined,
      absoluteRemaining: remaining,
      absoluteTotal: entitlement,
    });
  }

  return {
    windows,
    plan: data.copilot_plan,
    fetchedAt: now,
  };
}

// ------------------------------------------------------------------
// 输入区域用量指示器的格式化
// ------------------------------------------------------------------

/**
 * 将用量快照格式化为输入区域指示器的一行字符串。
 * 如果没有可用数据则返回 null（调用方应完全隐藏指示器）。
 *
 * 示例：
 *   "5h: 90% left | wk: 80% left"        （Codex，基于百分比）
 *   "month: 300/300 left"                （Copilot，离散计数）
 */
export function formatUsageLine(
  snapshot: UsageSnapshot | null | undefined,
): string | null {
  if (!snapshot) return null;
  if (snapshot.error) return null;
  if (snapshot.windows.length === 0) return null;

  const parts = snapshot.windows.map((w) => {
    const value =
      w.absoluteRemaining !== undefined && w.absoluteTotal !== undefined
        ? `${w.absoluteRemaining}/${w.absoluteTotal}`
        : `${w.remainPercent.toFixed(0)}%`;
    return `${w.label}: ${value} left`;
  });

  return parts.join(" | ");
}
