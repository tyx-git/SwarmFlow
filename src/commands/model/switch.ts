/** /model 命令入口与参数解析。 */

import {
  currentSessionModelDisplayName,
  persistModelSelection,
  persistRuntimeModelConfig,
  promptThinkingLevel,
} from "./persistence.js";
import { pickResolvedModelSelection } from "./selection-flow.js";
import { type CommandContext } from "../types.js";

function parseModelArgs(args: string): { target: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const target = tokens[0] ?? "";
  const rest = tokens.slice(1);
  const inlineKeySyntax = rest.some((t) => t.startsWith("key=") || t.startsWith("api_key="));
  if (inlineKeySyntax || rest.length === 1) {
    throw new Error(
      "Inline API keys in `/model` are no longer supported.\n" +
      "Use `/provider` to add or update credentials for common providers, or to register custom endpoints for Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Gemini generateContent.\n" +
      "Run `swarmflow init` only for the first-time configuration wizard.",
    );
  }
  if (rest.length > 0) {
    throw new Error(
      "Invalid /model arguments.\n" +
      "Use a config name or provider:model (for example `openai:gpt-5.4`).",
    );
  }
  return { target };
}

/**
 * /model 命令：通过创建新会话切换模型。
 *
 * 选中值既可以是配置名，也可以是 provider:model 形式的目标。
 */
export async function cmdModel(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim();

  if (!trimmed) {
    const current = currentSessionModelDisplayName(session) || "unknown";
    ctx.showMessage(
      `Current model: ${current}\n` +
      "Use /model to select a new model.\n" +
      "For models marked 'key missing', run 'swarmflow init' or select the model to import/paste a key.",
    );
    return;
  }

  if (!session.switchModel) {
    ctx.showMessage("Model switching is not supported in this session.");
    return;
  }

  try {
    const { target } = parseModelArgs(trimmed);
    if (!target) {
      const current = currentSessionModelDisplayName(session) || "unknown";
      ctx.showMessage(
        `Current model: ${current}\n` +
        "Run /model to select from registered models. Provider and model registration belongs to /provider.",
      );
      return;
    }
    const resolvedSelection = await pickResolvedModelSelection(ctx, {
      initialTarget: target,
      flatMessage: "Select model",
    });
    if (!resolvedSelection) {
      ctx.showMessage("Model switch cancelled.");
      return;
    }
    const { selectedConfigName } = resolvedSelection;

    if (!persistRuntimeModelConfig(ctx, resolvedSelection)) {
      throw new Error("The selected runtime model could not be persisted; the session model was not changed.");
    }

    // 适当地切换活动运行时；会话历史记录保持完整。
    session.switchModel(selectedConfigName);
    const activeConfig = session.primaryAgent?.modelConfig;
    if (
      !activeConfig
      || activeConfig.provider !== resolvedSelection.modelProvider
      || activeConfig.model !== resolvedSelection.modelId
    ) {
      throw new Error(
        `Model switch did not take effect: expected ${resolvedSelection.modelProvider}/${resolvedSelection.modelId}`,
      );
    }
    session.setPersistedModelSelection?.({
      modelConfigName: selectedConfigName,
      modelProvider: resolvedSelection.modelProvider,
      modelSelectionKey: resolvedSelection.modelSelectionKey,
      modelId: resolvedSelection.modelId,
    });
    // 如果新模型支持它，提示思考水平
    await promptThinkingLevel(ctx);
    persistModelSelection(ctx);
    ctx.autoSave();
  } catch (e) {
    ctx.showMessage(`Failed to switch model: ${e instanceof Error ? e.message : String(e)}`);
  }
}
