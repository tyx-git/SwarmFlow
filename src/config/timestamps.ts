/**
 * 会话存储使用的时间戳格式化。
 *
 * UTC ISO 与带本地时区偏移的 ISO 两种形态并存：前者写入磁盘上的
 * created_at/updated_at，后者供列表展示。
 */

/** 获取当前会话的时区标识符 */
function resolveSessionTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * 两个 ISO 时间戳是否落在同一分钟（UTC 绝对时间）。
 *
 * 伴生文件节流用：同一分钟内只需要保留首次的 last_active_at。
 * 无法解析或缺失时返回 false，调用方按"已变化"处理。
 */
export function isSameUtcMinute(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.floor(left / 60_000) === Math.floor(right / 60_000);
}

/** 将 Date 对象格式化为带本地时区偏移的 ISO 字符串 */
function formatLocalIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMins = pad(absOffset % 60);
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
    `${sign}${offsetHours}:${offsetMins}`,
  ].join("");
}

/** 将 UTC ISO 字符串转换为带本地时区偏移的 ISO 字符串 */
export function toLocalIsoFromUtc(utcIso: string): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return formatLocalIso(new Date(ms));
}

/** 获取当前时间的多种格式时间戳 */
export function nowTimestamps(): {
  utcIso: string;
  localIso: string;
  epochMs: number;
  timeZone: string;
} {
  const now = new Date();
  return {
    utcIso: now.toISOString(),
    localIso: formatLocalIso(now),
    epochMs: now.getTime(),
    timeZone: resolveSessionTimezone(),
  };
}
