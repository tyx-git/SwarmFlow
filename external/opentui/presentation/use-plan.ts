import { useEffect, useState, useCallback } from "react";

import type { Session } from "../../src/ui/contracts.js";
import type { PlanCheckpoint } from "../../src/plan-state.js";

/**
 * Hook to subscribe to session plan state changes.
 * Uses session.subscribePlan() for push updates.
 */
export function usePlan(session: Session): readonly PlanCheckpoint[] {
  const [plan, setPlan] = useState<readonly PlanCheckpoint[]>([]);

  const sync = useCallback(() => {
    const next = session.getPlanState?.() ?? [];
    setPlan((prev) => {
      if (prev.length !== next.length) return next;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].text !== next[i].text || prev[i].status !== next[i].status) {
          return next;
        }
      }
      return prev;
    });
  }, [session]);

  useEffect(() => {
    sync();
    const unsub = session.subscribePlan?.(sync);
    return () => { unsub?.(); };
  }, [session, sync]);

  return plan;
}
