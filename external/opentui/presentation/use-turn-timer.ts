import { useEffect, useRef, useState } from "react";
import type { ActivityPhase } from "../display/types.js";

export interface TurnTimerState {
  /** Elapsed seconds for the currently active turn. */
  elapsed: number;
  /** Elapsed seconds from the most recently completed turn. */
  lastElapsed: number;
  /** Start timestamp from the most recently completed turn. */
  lastStartedAt: number | null;
}

export function useTurnTimer(phase: ActivityPhase): TurnTimerState {
  const [elapsed, setElapsed] = useState(0);
  const [lastCompleted, setLastCompleted] = useState<Pick<TurnTimerState, "lastElapsed" | "lastStartedAt">>({
    lastElapsed: 0,
    lastStartedAt: null,
  });
  const accumulatedRef = useRef(0);
  const resumeAtRef = useRef<number>(0);
  const startedAtRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase === "Working") {
      const now = Date.now();
      if (startedAtRef.current === null) startedAtRef.current = now;
      resumeAtRef.current = now;
      intervalRef.current = setInterval(() => {
        setElapsed(accumulatedRef.current + (Date.now() - resumeAtRef.current) / 1000);
      }, 100);

      return () => {
        accumulatedRef.current += (Date.now() - resumeAtRef.current) / 1000;
        setElapsed(accumulatedRef.current);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }

    if (phase === "idle" || phase === "closing") {
      if (startedAtRef.current !== null && accumulatedRef.current > 0) {
        setLastCompleted({
          lastElapsed: accumulatedRef.current,
          lastStartedAt: startedAtRef.current,
        });
      }
      accumulatedRef.current = 0;
      startedAtRef.current = null;
      setElapsed(0);
    }
  }, [phase]);

  return {
    elapsed,
    ...lastCompleted,
  };
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/** Format a completed turn as the stable `Xm Ys` status shown in the composer. */
export function formatWorkedDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatWorkedStartTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
