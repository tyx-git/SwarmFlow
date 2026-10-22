/** /agents 子代理角色与角色模型配置。 */

import { join } from "node:path";

import { createUiText, getUiLanguage, type UiText } from "../../ui/text.js";
import type { SubagentRoleSettings, SubagentSettings } from "../../session/subagent-settings.js";
import { resolveRoleModel, type ResolvedRoleModel } from "../../session/role-model-resolver.js";
import {
  AGENT_ROLE_IDS,
  AGENT_ROLE_LABELS,
  isAgentRoleId,
  type AgentRole,
} from "../../swarm/types.js";
import { persistRuntimeModelConfig, promptThinkingLevel } from "./persistence.js";
import { pickResolvedModelSelection } from "./selection-flow.js";
import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

export function subagentRoleOptions(ctx: CommandOptionsContext): CommandOption[] {
  const saved = ctx.session.getSubagentSettings?.() as SubagentSettings | undefined;
  const text = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
  return AGENT_ROLE_IDS.map((role) => {
    try {
      const resolved = resolveRoleModel(ctx.session, role, saved);
      return {
        label: `${AGENT_ROLE_LABELS[role]} · ${describeRoleModel(role, resolved, text)}`,
        value: role,
      };
    } catch (error) {
      return {
        label: `${AGENT_ROLE_LABELS[role]} · ${text.get(["Views", "commandPicker", "roleModelUnavailable"])}`,
        value: role,
        detail: error instanceof Error ? error.message : String(error),
        detailColor: "error",
      };
    }
  });
}

const MANAGE_SUBAGENTS_VALUE = "__manage_subagents__";

function subagentActionOptions(ctx: CommandOptionsContext): CommandOption[] {
  const text = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
  return [
    {
      label: text.get(["Views", "commandPicker", "manageSubagents"]),
      value: MANAGE_SUBAGENTS_VALUE,
    },
    ...subagentRoleOptions(ctx),
  ];
}

function activeSubagentOptions(
  children: Array<{ id: string; template: string; lifecycle: string; lastToolCallSummary?: string }>,
): CommandOption[] {
  return children
    .filter((child) => child.lifecycle === "running" || child.lifecycle === "blocked")
    .map((child) => ({
      label: `${child.id} · ${AGENT_ROLE_LABELS[child.template as AgentRole] ?? child.template}`,
      value: child.id,
      detail: child.lastToolCallSummary || undefined,
    }));
}

function describeRoleModel(role: AgentRole, resolved: ResolvedRoleModel, text: UiText): string {
  const model = `${resolved.provider}/${resolved.modelId} ${resolved.thinkingLevel}`;
  if (resolved.source === "role") return model;
  const inheritance = role === "queen"
    ? text.get(["Views", "commandPicker", "queenCurrentModel"])
    : text.get(["Views", "commandPicker", "inheritQueenModel"]);
  return `${inheritance} (${model})`;
}

/** 配置当前会话中新建子代理使用的默认模型与思考深度。 */
export async function cmdAgents(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const target = args.trim();
  let settings: SubagentSettings | undefined;
  try {
    settings = session.getSubagentSettings?.() as SubagentSettings | undefined;
  } catch (error) {
    ctx.showMessage(`Failed to load sub-agent role settings: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const role = target ? target.split(/\s+/, 1)[0] : "";

  if (!target && !ctx.promptCommandPicker) {
    const text = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
    const configured = AGENT_ROLE_IDS
      .map((id) => {
        try {
          return `${AGENT_ROLE_LABELS[id]}: ${describeRoleModel(id, resolveRoleModel(session, id, settings), text)}`;
        } catch (error) {
          return `${AGENT_ROLE_LABELS[id]}: ${error instanceof Error ? error.message : String(error)}`;
        }
      })
      .join("\n");
    ctx.showMessage(configured);
    return;
  }

  try {
    const text = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
    const selectedRole = role || (ctx.promptCommandPicker ? (await ctx.promptCommandPicker(
      subagentActionOptions({ session, store: ctx.store, swarmflowHomeDir: ctx.swarmflowHomeDir }),
      { title: text.get(["Views", "commandPicker", "selectRoleOrManage"]), inputArea: true },
    ))?.value ?? "" : "");
    if (selectedRole === MANAGE_SUBAGENTS_VALUE) {
      const children = activeSubagentOptions(session.getChildSessionSnapshots?.() ?? []);
      if (children.length === 0) {
        ctx.showHint?.(text.get(["Views", "commandPicker", "noActiveSubagents"]));
        return;
      }
      const selectedChildId = (await ctx.promptCommandPicker?.(children, {
        title: text.get(["Views", "commandPicker", "manageSubagentsTitle"]),
        inputArea: true,
      }))?.value;
      if (!selectedChildId) return;
      const result = session.killChildSession?.(selectedChildId);
      if (result?.accepted) {
        ctx.showHint?.(text.get(["Views", "agents", "killed"], { agentId: selectedChildId }));
      } else {
        ctx.showHint?.(text.get(["Error", "killSubagentFailed"], {
          reason: result?.reason ?? text.get(["Common", "unknown"]),
        }));
      }
      return;
    }
    if (!isAgentRoleId(selectedRole)) {
      if (role) ctx.showMessage(`Unknown sub-agent role '${role}'.`);
      return;
    }
    const current = settings?.roles[selectedRole];
    let currentResolution: ResolvedRoleModel | undefined;
    try {
      currentResolution = resolveRoleModel(session, selectedRole, settings);
    } catch (error) {
      ctx.showHint?.(error instanceof Error ? error.message : String(error));
    }
    const modelTarget = target.slice(role.length).trim();
    const resolved = await pickResolvedModelSelection(ctx, {
      initialTarget: modelTarget,
      flatMessage: `Select ${AGENT_ROLE_LABELS[selectedRole]} model`,
      picker: {
        title: text.get(["Views", "commandPicker", "selectProviderAndModel"]),
        inputArea: true,
      },
      treeOverrides: currentResolution ? {
        currentSelection: {
          configName: currentResolution.configName,
          provider: currentResolution.provider,
          selectionKey: currentResolution.selectionKey,
          modelId: currentResolution.modelId,
        },
      } : current ? {
        currentSelection: {
          configName: current.config_name,
          provider: current.provider,
          selectionKey: current.selection_key,
          modelId: current.model_id,
        },
      } : undefined,
    });
    if (!resolved) {
      ctx.showMessage("Sub-agent model configuration cancelled.");
      return;
    }

    const thinkingLevel = await promptThinkingLevel(ctx, {
      current: current?.thinking_level ?? currentResolution?.thinkingLevel ?? session.thinkingLevel ?? "off",
      applyToSession: false,
    });
    if (!thinkingLevel) {
      ctx.showMessage("Sub-agent model configuration cancelled.");
      return;
    }

    const roleSettings: SubagentRoleSettings = {
      config_name: resolved.selectedConfigName,
      provider: resolved.modelProvider,
      selection_key: resolved.modelSelectionKey,
      model_id: resolved.modelId,
      thinking_level: thinkingLevel,
    };
    if (!persistRuntimeModelConfig(ctx, resolved)) {
      throw new Error("The selected runtime model could not be persisted; the role settings were not changed.");
    }
    if (typeof session.setSubagentSettings !== "function") {
      throw new Error("Sub-agent model settings are not available in this session.");
    }
    const nextSettings: SubagentSettings = {
      version: 1,
      roles: { ...(settings?.roles ?? {}), [selectedRole]: roleSettings },
    };
    session.setSubagentSettings(nextSettings);
    ctx.showHint?.(`${AGENT_ROLE_LABELS[selectedRole]} set: ${resolved.modelProvider}/${resolved.modelId} ${thinkingLevel}`);
    ctx.autoSave();
  } catch (error) {
    ctx.showMessage(`Failed to configure sub-agent model: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ------------------------------------------------------------------
// Provider 子流程——管理 API 密钥（替换/删除/导入）
// ------------------------------------------------------------------
