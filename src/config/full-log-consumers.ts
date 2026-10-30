/** 需要读取完整日志的调用方清单，以及它们对归档冷区的约定。 */

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
