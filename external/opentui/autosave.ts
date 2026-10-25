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

export function persistSessionLog(session: SessionLogSaver, hasSessionDir: boolean): boolean {
  if (!hasSessionDir) return false;
  try {
    const meta = session.getLogForPersistence?.().meta;
    if (!meta || meta.turnCount === 0) return false;
    return session.persistToDisk?.() === true;
  } catch {
    return false;
  }
}
