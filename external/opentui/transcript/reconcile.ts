import { isDeepStrictEqual } from "node:util";

import type { ConversationEntry } from "../../../src/ui/contracts.js";

import type { ReconciledConversationEntry } from "./types.js";

function getReconciledEntryId(entry: ConversationEntry, index: number): string {
  return entry.id ?? `anonymous:${index}:${entry.kind}`;
}

function sameConversationEntry(
  left: ConversationEntry,
  right: ConversationEntry,
): boolean {
  return left.kind === right.kind
    && left.text === right.text
    && left.startedAt === right.startedAt
    && left.elapsedMs === right.elapsedMs
    && left.id === right.id
    && left.queued === right.queued
    && left.dim === right.dim
    && isDeepStrictEqual(left.meta, right.meta);
}

export function reconcileEntries(
  previous: readonly ReconciledConversationEntry[],
  nextEntries: readonly ConversationEntry[],
): ReconciledConversationEntry[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));

  return nextEntries.map((entry, index) => {
    const id = getReconciledEntryId(entry, index);
    const existing = previousById.get(id);
    if (existing && sameConversationEntry(existing.entry, entry)) {
      return existing;
    }
    return {
      id,
      entry,
      contentVersion: existing ? existing.contentVersion + 1 : 1,
    };
  });
}
