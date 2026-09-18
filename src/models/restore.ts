import type { PersistedModelSelection, ResolvedModelSelection } from "../models/selection.js";
import { resolvePersistedModelSelection } from "../models/selection.js";

export function applyPersistedModelSelectionToSession(
  session: any,
  selection: PersistedModelSelection,
): ResolvedModelSelection {
  const resolved = resolvePersistedModelSelection(session, selection);
  session.switchModel(resolved.selectedConfigName);
  session.setPersistedModelSelection?.({
    modelConfigName: resolved.selectedConfigName,
    modelProvider: resolved.modelProvider,
    modelSelectionKey: resolved.modelSelectionKey,
    modelId: resolved.modelId,
  });
  return resolved;
}
