import type { ModelConfig } from "../config/config.js";
import { resolvePersistedModelSelection } from "../models/selection.js";
import { isAgentRoleId, type AgentRole } from "../swarm/types.js";
import type { SubagentSettings } from "./subagent-settings.js";

export interface ResolvedRoleModel {
  role: string;
  source: "role" | "queen";
  configName: string;
  provider: string;
  selectionKey: string;
  modelId: string;
  modelConfig: ModelConfig;
  thinkingLevel: string;
}

export class RoleModelResolutionError extends Error {
  constructor(readonly role: string, detail: string, cause?: unknown) {
    super(`Configured model for role '${role}' cannot be resolved: ${detail}`, { cause });
    this.name = "RoleModelResolutionError";
  }
}

/** Resolve every role from its session setting or the active Queen model. */
export function resolveRoleModel(
  session: any,
  role: string,
  settings: SubagentSettings | undefined = session.getSubagentSettings?.(),
): ResolvedRoleModel {
  const roleSettings = isAgentRoleId(role) ? settings?.roles[role as AgentRole] : undefined;
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
      thinkingLevel: session.thinkingLevel || "off",
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
