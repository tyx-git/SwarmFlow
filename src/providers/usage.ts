/**
 * OpenAI Codex usage tracking 鈥?fetch rate-limit data and poll periodically.
 *
 * Data source: GET https://chatgpt.com/backend-api/wham/usage
 * Requires a valid OAuth access token (same as Codex API calls).
 */

import { EventEmitter } from "node:events";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface UsageWindow {
  /** Human label for the window, e.g. "5h", "Wk", "month". */
  label: string;
  /** Percentage of quota remaining (0鈥?00). */
  remainPercent: number;
  /** Absolute reset time (ms since epoch), if available. */
  resetAt?: number;
  /** Absolute remaining count, when the provider exposes discrete integer quotas (Copilot). */
  absoluteRemaining?: number;
  /** Absolute total entitlement, paired with absoluteRemaining (Copilot). */
  absoluteTotal?: number;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan?: string;
  error?: string;
  /** Timestamp when this snapshot was fetched. */
  fetchedAt: number;
}

// ------------------------------------------------------------------
// Fetch
// ------------------------------------------------------------------

/** Minimum gap (seconds) between secondary and primary reset to infer weekly. */
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
 * Fetch Codex usage from the ChatGPT backend.
 * Returns a snapshot with rate-limit windows and optional plan info.
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
// Format helpers
// ------------------------------------------------------------------

/**
 * Format a reset timestamp as a human-readable remaining string.
 * Uses "in Xh Ym" / "in Xd Yh" / "in Xm" format. No emoji.
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
// Poller
// ------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface UsagePollerEvents {
  update: [snapshot: UsageSnapshot];
  error: [error: Error];
}

/** Function that fetches a usage snapshot given some credential token. */
export type UsageFetchFn = (token: string) => Promise<UsageSnapshot>;

export interface UsagePollerOptions {
  /** Snapshot producer. Defaults to Codex fetch for backward compatibility. */
  fetchFn?: UsageFetchFn;
  /** Poll interval in ms. Defaults to 60s. */
  intervalMs?: number;
}

/**
 * Periodically polls a quota/usage endpoint and emits "update" events.
 *
 * Usage:
 *   const poller = new UsagePoller({ fetchFn: fetchCopilotUsage });
 *   poller.on("update", (snapshot) => { ... });
 *   poller.start(token);
 *   // later:
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
    // Back-compat: constructor used to accept just an intervalMs number.
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
    // Fetch immediately, then on interval.
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

  /** Update the token without restarting the poll cycle. */
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
// Copilot usage fetch (legacy premium-request quota 鈥?annual plans only)
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
 * Fetch GitHub Copilot usage from api.github.com/copilot_internal/user.
 * Called with the LONG-LIVED GitHub OAuth token, NOT the short-lived Copilot
 * API token 鈥?this endpoint is on api.github.com, not api.githubcopilot.com.
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
// Formatting for the input-area usage indicator
// ------------------------------------------------------------------

/**
 * Format a usage snapshot into a one-line string for the input-area
 * indicator. Returns null if no data is available (callers should hide
 * the indicator entirely in that case).
 *
 * Examples:
 *   "5h: 90% left | wk: 80% left"        (Codex, percent-based)
 *   "month: 300/300 left"                (Copilot, discrete count)
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
