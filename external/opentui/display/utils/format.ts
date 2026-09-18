import { osCapabilities } from "../../../../src/platform/index.js";
import { stringWidth } from "../../forked/core/platform/runtime.js";

export function formatCompactTokens(value: number | undefined): string {
  const safeValue = value ?? 0;
  if (safeValue >= 1_000_000) {
    const compact = safeValue / 1_000_000;
    return `${compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)}M`;
  }
  if (safeValue >= 100_000) {
    return `${(safeValue / 1_000).toFixed(0)}k`;
  }
  if (safeValue >= 1_000) {
    return `${(safeValue / 1_000).toFixed(1)}k`;
  }
  return `${safeValue}`;
}

export function formatCompactTokensShort(value: number | undefined): string {
  if (value == null || value === 0) return "0";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function formatTokens(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

export function formatUsagePercent(contextTokens: number, contextLimit?: number): string {
  if (!contextLimit || contextLimit <= 0) return "0.0%";
  return `${((contextTokens / contextLimit) * 100).toFixed(1)}%`;
}

export function formatExpiryRemaining(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

export function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return fullPath;
  // Case-insensitive filesystems (macOS, Windows) can hand us the same
  // location in different casing (drive letter, profile dir) — fold before
  // comparing. The boundary check keeps /Users/felixfoo from shortening
  // under /Users/felix.
  const fold = (s: string) => (osCapabilities.caseInsensitiveFilesystem ? s.toLowerCase() : s);
  if (!fold(fullPath).startsWith(fold(home))) return fullPath;
  const rest = fullPath.slice(home.length);
  if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return "~" + rest;
  return fullPath;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  const textWidth = stringWidth(text);
  if (textWidth <= maxWidth) return text;
  const target = maxWidth - 3;
  if (target <= 0) return "...".slice(0, maxWidth);
  let width = 0;
  let index = 0;
  for (const ch of text) {
    const chWidth = stringWidth(ch) || 1;
    if (width + chWidth > target) return text.slice(0, index) + "...";
    width += chWidth;
    index += ch.length;
  }
  return text;
}

/**
 * 秒级耗时的可读格式：30s / 1m 30s / 2h 5m。
 * 会话回合耗时与后台 shell 耗时共用，避免各处各写一份。
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function countWrappedDisplayLines(text: string, contentWidth: number): number {
  const safeWidth = Math.max(1, contentWidth);
  const lines = text.split("\n");
  return lines.reduce((sum, line) => {
    const width = Math.max(1, stringWidth(line || " "));
    return sum + Math.max(1, Math.ceil(width / safeWidth));
  }, 0);
}
