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
    // TaskStore.update mutates its in-memory Task object in place. Keep an
    // immutable UI snapshot so the previous React state cannot silently change
    // underneath sameTasks() before the subscription callback runs.
    const snapshot = next.map(cloneTaskForUi);
    setTasks((prev) => (sameTasks(prev, snapshot) ? prev : snapshot));
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

/**
 * React owns this copy. The session store is an imperative mutable model, so
 * retaining its Task references would make the previous state observe updates
 * before React gets a chance to compare them.
 */
function cloneTaskForUi(task: Task): Task {
  return {
    ...task,
    metadata: { ...task.metadata },
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
  };
}

/** 引用相等优先；任务字段变化时才换新数组。 */
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
      a.owner !== b.owner ||
      a.blockedBy.length !== b.blockedBy.length ||
      a.blockedBy.some((id, index) => id !== b.blockedBy[index]) ||
      a.blocks.length !== b.blocks.length ||
      a.blocks.some((id, index) => id !== b.blocks[index])
    ) {
      return false;
    }
  }
  return true;
}
