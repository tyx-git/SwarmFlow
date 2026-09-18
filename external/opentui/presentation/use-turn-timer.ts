import { useEffect, useRef, useState } from "react";
import type { ActivityPhase } from "../display/types.js";

export function useTurnTimer(phase: ActivityPhase): number {
  const [elapsed, setElapsed] = useState(0);
  const accumulatedRef = useRef(0);
  const resumeAtRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase === "Working") {
      resumeAtRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        setElapsed(accumulatedRef.current + (Date.now() - resumeAtRef.current) / 1000);
      }, 100);

      return () => {
        accumulatedRef.current += (Date.now() - resumeAtRef.current) / 1000;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }

    if (phase === "idle" || phase === "closing") {
      accumulatedRef.current = 0;
      setElapsed(0);
    }
  }, [phase]);

  return elapsed;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}
