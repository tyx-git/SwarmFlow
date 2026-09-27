import { useCallback, useEffect, useState } from "react";

import type { Session } from "../../../src/ui/contracts.js";
import type { Task } from "../../../src/lib/task-store.js";

/**
 * 订阅当前会话的任务清单。
 *
 * 读路径完全走内存（store 只在构造时读盘）—— 与 pi-tasks 每帧同步读盘不同，
 * 这里由 Session 的订阅推送驱动，渲染不触发任何 IO。
 *
 * 持久化状态由 `session.getTaskPersistence()` 单独提供（`"memory"` 才需要标注），
 * 本 hook 不做 IO 也不关心它。
 */
export function useTasks(session: Session): readonly Task[] {
  const [tasks, setTasks] = useState<readonly Task[]>([]);

  const sync = useCallback(() => {
    const next = session.getTaskState?.() ?? [];
    setTasks((prev) => (sameTasks(prev, next) ? prev : next));
  }, [session]);

  useEffect(() => {
    sync();
    const unsub = session.subscribeTaskState?.(sync);
    return () => {
      unsub?.();
    };
  }, [session, sync]);

  return tasks;
}

/** 引用相等优先；仅在 id/status/subject/activeForm 变化时换新数组。 */
function sameTasks(prev: readonly Task[], next: readonly Task[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.subject !== b.subject ||
      a.activeForm !== b.activeForm ||
      a.blockedBy.length !== b.blockedBy.length
    ) {
      return false;
    }
  }
  return true;
}
