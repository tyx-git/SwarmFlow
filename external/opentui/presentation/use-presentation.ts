import { useMemo, useRef } from "react";

import type { ChildSessionSnapshot } from "../../src/session-tree-types.js";
import type { Session as TuiSession } from "../../src/ui/contracts.js";

import { useTranscriptModel } from "../transcript/use-transcript-model.js";
import type { PresentationEntry } from "./types.js";
import { presentationTransform } from "./transform.js";

interface UsePresentationOptions {
  session: TuiSession;
  selectedChildId: string | null;
  childSessions: readonly ChildSessionSnapshot[];
  processing: boolean;
}

export function usePresentationEntries(
  { session, selectedChildId, childSessions, processing }: UsePresentationOptions,
): PresentationEntry[] {
  const active = processing || childSessions.some((c) => c.running);
  const reconciledItems = useTranscriptModel({ session, selectedChildId, childSessions, active });
  const previousRef = useRef<PresentationEntry[]>([]);
  // Read activeEntryId from session 鈥?changes propagate via log revision bump
  const activeEntryId = session.activeLogEntryId ?? null;

  const presentationItems = useMemo(() => {
    const result = presentationTransform(reconciledItems, previousRef.current, processing, activeEntryId);
    previousRef.current = result;
    return result;
  }, [reconciledItems, processing, activeEntryId]);

  return presentationItems;
}
