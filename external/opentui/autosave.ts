/**
 * D10：检查点保存的布尔结果（`onSaveRequest: () => boolean`）。
 *
 * 只负责“日志是否真正落盘成功”；模型选择状态持久化仍留在调用方。
 * 无会话目录、0 轮、缺少实现或抛错都视为未保存。
 */

import type { Session as TuiSession } from "../../src/ui/contracts.js";

export interface SessionLogSaver {
  getLogForPersistence?: () => { meta: { turnCount: number } };
  persistToDisk?: () => boolean;
}

type Assert<T extends true> = T;
/** 编译期锁：TUI 会话面的 onSaveRequest 必须返回 boolean。 */
type _OnSaveRequestReturnsBoolean = Assert<
  ReturnType<NonNullable<TuiSession["onSaveRequest"]>> extends boolean ? true : false
>;

export interface PersistSessionLogResult {
  ok: boolean;
  error?: string;
}

export function persistSessionLogResult(session: SessionLogSaver, hasSessionDir: boolean): PersistSessionLogResult {
  if (!hasSessionDir) return { ok: false, error: "session directory is unavailable" };
  try {
    const meta = session.getLogForPersistence?.().meta;
    if (!meta || meta.turnCount === 0) return { ok: false, error: "session has no persisted turns" };
    if (session.persistToDisk?.() !== true) return { ok: false, error: "persistence returned false" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function persistSessionLog(session: SessionLogSaver, hasSessionDir: boolean): boolean {
  return persistSessionLogResult(session, hasSessionDir).ok;
}

export type SessionSaveStatus = {
  state: "dirty" | "retrying" | "saved" | "failed";
  dirty: boolean;
  attempt: number;
  error?: string;
  retryInMs?: number;
};

const SAVE_DEBOUNCE_MS = 2_000;
const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export class SessionSaveController {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private retryAttempt = 0;
  private disposed = false;

  constructor(
    private readonly session: SessionLogSaver,
    private readonly hasSessionDir: () => boolean,
    private readonly onStatus?: (status: SessionSaveStatus) => void,
    private readonly beforePersist?: () => void,
  ) {}

  schedule(): boolean {
    if (this.disposed) return false;
    this.dirty = true;
    this.clearTimers();
    this.retryAttempt = 0;
    this.onStatus?.({ state: "dirty", dirty: true, attempt: 0 });
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    return false;
  }

  flush(): boolean {
    if (this.disposed) return false;
    this.clearTimers();
    try {
      this.beforePersist?.();
    } catch {
      // Model selection persistence must not block the session log retry path.
    }
    // 干净会话没有待落盘内容；退出时的强制 flush 不应因此报保存失败。
    if (!this.dirty) return true;
    const result = persistSessionLogResult(this.session, this.hasSessionDir());
    if (result.ok) {
      this.dirty = false;
      this.retryAttempt = 0;
      this.onStatus?.({ state: "saved", dirty: false, attempt: 0 });
      return true;
    }

    this.dirty = true;
    const attempt = this.retryAttempt + 1;
    this.retryAttempt = attempt;
    const delay = SAVE_RETRY_DELAYS_MS[attempt - 1];
    if (delay !== undefined) {
      this.onStatus?.({
        state: "retrying",
        dirty: true,
        attempt,
        error: result.error,
        retryInMs: delay,
      });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.flush();
      }, delay);
    } else {
      this.onStatus?.({ state: "failed", dirty: true, attempt, error: result.error });
    }
    return false;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
