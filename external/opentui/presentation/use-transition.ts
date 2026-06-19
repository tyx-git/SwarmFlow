import { useEffect, useRef, useState } from "react";

/**
 * Smoothly transitions a numeric value toward a target over `durationMs`.
 * Returns the current interpolated value (0–1 range for typical use).
 *
 * Uses ease-out for rising (0→1) and ease-in for falling (1→0)
 * to give a responsive "light up" and natural "fade away" feel.
 */
export function useTransition(target: number, durationMs: number): number {
  const [current, setCurrent] = useState(target);
  const rafRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<{ time: number; from: number; to: number } | null>(null);

  useEffect(() => {
    if (rafRef.current) {
      clearInterval(rafRef.current);
      rafRef.current = null;
    }

    setCurrent((prev) => {
      if (prev === target) return prev;
      startRef.current = { time: Date.now(), from: prev, to: target };
      return prev;
    });

    if (durationMs <= 0) {
      setCurrent(target);
      return;
    }

    const STEP_MS = 16;
    rafRef.current = setInterval(() => {
      const start = startRef.current;
      if (!start) {
        setCurrent(target);
        if (rafRef.current) clearInterval(rafRef.current);
        rafRef.current = null;
        return;
      }

      const elapsed = Date.now() - start.time;
      const linear = Math.min(1, elapsed / durationMs);
      // ease-out when rising, ease-in when falling
      const eased = start.to > start.from
        ? 1 - (1 - linear) * (1 - linear)     // ease-out
        : linear * linear;                      // ease-in
      const value = start.from + (start.to - start.from) * eased;

      if (linear >= 1) {
        setCurrent(start.to);
        startRef.current = null;
        if (rafRef.current) clearInterval(rafRef.current);
        rafRef.current = null;
      } else {
        setCurrent(value);
      }
    }, STEP_MS);

    return () => {
      if (rafRef.current) {
        clearInterval(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs]);

  return current;
}
