import type { ModelConfig } from "../config/types.js";
import { resolvePersistedModelSelection, type PersistedModelSelection } from "../models/selection.js";
import { isAgentRoleId, type AgentRole } from "../swarm/types.js";
import type { SessionLike } from "./contract.js";
import type { SubagentSettings } from "./subagent-settings.js";

export interface ResolvedRoleModel {
  role: string;
  source: "role" | "queen" | "persisted";
  configName: string;
  provider: string;
  selectionKey: string;
  modelId: string;
  modelConfig: ModelConfig;
  thinkingLevel: string;
}

export interface PersistedRoleModelSelection extends PersistedModelSelection {
  thinkingLevel?: string;
}

export class RoleModelResolutionError extends Error {
  constructor(readonly role: string, detail: string, cause?: unknown) {
    super(`Configured model for role '${role}' cannot be resolved: ${detail}`, { cause });
    this.name = "RoleModelResolutionError";
  }
}

export function resolveInheritedThinkingLevel(session: SessionLike): string {
  const runtimeLevel = session.thinkingLevel;
  if (typeof runtimeLevel === "string" && runtimeLevel && runtimeLevel !== "none") {
    return runtimeLevel;
  }

  const preferredLevel = session.getGlobalPreferences?.()?.thinkingLevel;
  return typeof preferredLevel === "string" && preferredLevel && preferredLevel !== "none"
    ? preferredLevel
    : "off";
}

/** Resolve every role from its session setting or the active Queen model. */
export function resolveRoleModel(
  session: SessionLike,
  role: string,
  settings?: SubagentSettings,
  persistedSelection?: PersistedRoleModelSelection,
): ResolvedRoleModel {
  if (persistedSelection) {
    try {
      const resolved = resolvePersistedModelSelection(session, persistedSelection);
      return {
        role,
        source: "persisted",
        configName: resolved.selectedConfigName,
        provider: resolved.modelProvider,
        selectionKey: resolved.modelSelectionKey,
        modelId: resolved.modelId,
        modelConfig: session.config.getModel(resolved.selectedConfigName),
        thinkingLevel: persistedSelection.thinkingLevel || "off",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoleModelResolutionError(role, `saved child-session model cannot be restored: ${detail}`, error);
    }
  }

  const effectiveSettings = settings ?? session.getSubagentSettings?.();
  const roleSettings = isAgentRoleId(role) ? effectiveSettings?.roles[role as AgentRole] : undefined;
  if (!roleSettings) {
    const modelConfig = session.primaryAgent.modelConfig as ModelConfig;
    return {
      role,
      source: "queen",
      configName: modelConfig.name ?? "",
      provider: modelConfig.provider,
      selectionKey: modelConfig.model,
      modelId: modelConfig.model,
      modelConfig,
      thinkingLevel: resolveInheritedThinkingLevel(session),
    };
  }

  try {
    const resolved = resolvePersistedModelSelection(session, {
      modelConfigName: roleSettings.config_name,
      modelProvider: roleSettings.provider,
      modelSelectionKey: roleSettings.selection_key,
      modelId: roleSettings.model_id,
    });
    return {
      role,
      source: "role",
      configName: resolved.selectedConfigName,
      provider: resolved.modelProvider,
      selectionKey: resolved.modelSelectionKey,
      modelId: resolved.modelId,
      modelConfig: session.config.getModel(resolved.selectedConfigName),
      thinkingLevel: roleSettings.thinking_level,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RoleModelResolutionError(role, detail, error);
  }
}
