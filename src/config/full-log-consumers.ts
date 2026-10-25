/** Full-log consumers and their cold-zone contract. */

export interface FullLogConsumerContract {
  name: string;
  skipsArchived: boolean;
  requiredKeys?: readonly string[];
}

export const FULL_LOG_CONSUMERS: readonly FullLogConsumerContract[] = Object.freeze([
  { name: "validateAndRepairLog", skipsArchived: true },
  { name: "aggregateTokenUsage", skipsArchived: true },
  {
    name: "generateSummary",
    skipsArchived: false,
    requiredKeys: ["archive.index.turns.preview"],
  },
  { name: "rebuildRuntimeSignalsIn", skipsArchived: true },
  { name: "indexChildOutcomesFromLog", skipsArchived: true },
  {
    name: "listTurns",
    skipsArchived: false,
    requiredKeys: ["archive.index.entryIds", "archive.index.turns", "contextId"],
  },
  {
    name: "aggregateEntryMutations",
    skipsArchived: false,
    requiredKeys: ["archive.index.entryIds", "archive.index.mutations", "fileMutationReverted*"],
  },
]);
