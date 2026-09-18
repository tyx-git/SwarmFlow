import type { ConversationEntry } from "../../../src/ui/contracts.js";

export interface ReconciledConversationEntry {
  id: string;
  entry: ConversationEntry;
  contentVersion: number;
}
