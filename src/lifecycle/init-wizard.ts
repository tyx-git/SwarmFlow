/**
 * Initialization wizard for swarmflow.
 *
 * Provides an interactive first-run setup experience using @inquirer/prompts.
 * Saves provider configuration to ~/.swarmflow/settings.json + state/model-selection.json.
 * Supports Ctrl+C / ESC to go back to the previous step.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { select, input, confirm } from "@inquirer/prompts";
import { getSwarmflowHomeDir } from "./lib/home-path.js";
import {
  PROVIDER_PRESETS,
  buildProviderPresetRawConfig,
  type ProviderPreset,
} from "./providers/presets.js";
import { fetchModelsFromServer } from "./models/discovery.js";
import { setDotenvKey } from "./lifecycle/dotenv.js";
import {
  type SwarmflowSettings,
  type ModelSelectionState,
  type ProviderEntry,
  type ModelTierEntry,
  saveSettings,
  globalSettingsPath,
  saveModelSelectionState,
  loadGlobalSettings,
} from "./config/persistence.js";
import {
  hasAnyManagedCredential,
  hasManagedCredential,
  isManagedProvider,
} from "./config/managed-provider-credentials.js";
import {
  ensureManagedProviderCredential,
  type CredentialPromptAdapter,
  type CredentialSlot,
  resolveCredentialSlot,
  isCredentialConfigured,
  credentialImportCandidates,
  currentCredentialKey,
  maskKey,
  setCredentialKey,
} from "./providers/credential-flow.js";
import { providerCredentialKind } from "./config/managed-provider-credentials.js";
import { Config, getThinkingLevels, getTierEligibleThinkingLevels } from "./config/config.js";
import {
  buildModelPickerTree,
  buildCredentialEndpointTree,
  labelModelPickerNode,
  type ModelPickerTreeNode,
} from "./models/picker-tree.js";
import { createModelTierEntry, parseProviderModelTarget } from "./models/selection.js";
import { describeModel } from "./models/presentation.js";

// ------------------------------------------------------------------
// Wizard result
// ------------------------------------------------------------------

export interface WizardResult {
  homeDir: string;
}

// ------------------------------------------------------------------
// Internal types
// ------------------------------------------------------------------

/** Result of configuring a single provider. */
interface ProviderConfigResult {
  providerId: string;
  providerEntry: ProviderEntry;
  skipped?: boolean;
}

/** A fully selected model: provider + model key + model id + config name. */
interface ModelSelection {
  configName: string;   // "providerId:modelKey"
  providerId: string;
  selectionKey: string; // model key
  modelId: string;      // actual API model id
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).name === "ExitPromptError" ||
    (err as any).code === "ERR_USE_AFTER_CLOSE";
}

// ------------------------------------------------------------------
// Esc-aware prompt layer + linear navigation.
//
// Every interactive screen returns its value or BACK. Esc (and Ctrl+C) abort
// the active prompt and the navigator steps back exactly one screen; backing
// out of the first screen cancels the wizard. "Go back" is never a thrown
// exception that crosses more than one screen boundary, so it cannot
// over-rewind. inquirer's own cleanup runs on abort (screen.done in its
// finally), so the terminal is restored before the next prompt renders.
// ------------------------------------------------------------------

const BACK = Symbol("wizard-back");
type Back = typeof BACK;

function isAbortPromptError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "AbortPromptError";
}

async function withEscBack<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | Back> {
  const controller = new AbortController();
  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  const onKey = (_str: string | undefined, key: { name?: string } | undefined) => {
    if (key?.name === "escape") controller.abort();
  };
  stdin.on("keypress", onKey);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (isAbortPromptError(err) || isUserCancel(err)) return BACK;
    throw err;
  } finally {
    stdin.removeListener("keypress", onKey);
  }
}

interface SelectStepChoice {
  name: string;
  value: string;
}

/** Append "Esc/Ctrl+C back" to the select help line (next to navigate/select). */
const ansiBold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const ansiDim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const ESC_BACK_SELECT_THEME = {
  style: {
    keysHelpTip: (keys: [string, string][]) =>
      [...keys, ["Esc/Ctrl+C", "back"] as [string, string]]
        .map(([key, action]) => `${ansiBold(key)} ${ansiDim(action)}`)
        .join(ansiDim(" 鈥?")),
  },
};

async function selectStep(opts: { message: string; choices: SelectStepChoice[] }): Promise<string | Back> {
  return withEscBack((signal) =>
    select({ message: opts.message, choices: opts.choices, theme: ESC_BACK_SELECT_THEME }, { signal }),
  );
}

async function inputStep(opts: { message: string; default?: string }): Promise<string | Back> {
  return withEscBack((signal) => input({ message: opts.message, default: opts.default }, { signal }));
}

async function confirmStep(opts: { message: string; default?: boolean }): Promise<boolean | Back> {
  return withEscBack((signal) => confirm({ message: opts.message, default: opts.default }, { signal }));
}

/** Drill-down tree picker. Esc pops one level; Esc at the root returns BACK. */
async function selectTreeStep(nodes: ModelPickerTreeNode[], message: string): Promise<string | Back> {
  const stack: Array<{ message: string; nodes: ModelPickerTreeNode[] }> = [{ message, nodes }];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const choices = current.nodes.map((node) => ({ name: labelModelPickerNode(node), value: node.id }));
    const picked = await selectStep({ message: current.message, choices });
    if (picked === BACK) {
      stack.pop();
      if (stack.length === 0) return BACK;
      continue;
    }
    const node = current.nodes.find((n) => n.id === picked);
    if (!node) continue;
    if (node.children && node.children.length > 0) {
      stack.push({ message: node.label, nodes: node.children });
      continue;
    }
    return node.value;
  }
  return BACK;
}

function createInitPromptAdapter(): CredentialPromptAdapter {
  return {
    select: async (request) => {
      return select({
        message: request.message,
        choices: request.options.map((option) => ({
          name: option.description ? `${option.label} 鈥?${option.description}` : option.label,
          value: option.value,
        })),
      });
    },
    secret: async (request) => {
      const value = await input({
        message: request.message,
      });
      if (!request.allowEmpty && value.trim() === "") return "";
      return value;
    },
  };
}

/**
 * Check whether a provider preset is already configured (has key / credentials).
 */
function isProviderConfigured(preset: ProviderPreset, configuredProviders: Map<string, ProviderEntry>): boolean {
  if (configuredProviders.has(preset.id)) return true;
  if (preset.localServer) return false;
  if (isManagedProvider(preset.id)) {
    return hasManagedCredential(preset.id);
  }
  return Boolean(process.env[preset.envVar]);
}

function createWizardPickerSession(
  configuredProviders: Map<string, ProviderEntry>,
  currentSelection?: ModelSelection,
): any {
  const config = new Config({});

  for (const [providerId, entry] of configuredProviders) {
    if (entry.base_url && entry.model) {
      config.upsertModelRaw(`${providerId}:${entry.model}`, {
        provider: providerId,
        model: entry.model,
        api_key: entry.api_key ?? "local",
        base_url: entry.base_url,
        context_length: entry.context_length,
        supports_web_search: false,
      });
      continue;
    }

    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === providerId);
    if (!preset || preset.localServer) continue;

    const placeholderKey =
      providerId === "openai-codex"
        ? "oauth:openai-codex"
        : providerId === "copilot"
          ? "oauth:copilot"
          : "wizard-configured";

    for (const model of preset.models) {
      config.upsertModelRaw(
        `${providerId}:${model.key}`,
        buildProviderPresetRawConfig(providerId, model, placeholderKey),
      );
    }
  }

  let currentModelConfig: Record<string, unknown> | undefined;
  if (currentSelection) {
    try {
      currentModelConfig = config.getModel(currentSelection.configName) as unknown as Record<string, unknown>;
    } catch {
      currentModelConfig = {
        provider: currentSelection.providerId,
        model: currentSelection.modelId,
      };
    }
  }

  return {
    config,
    currentModelConfigName: currentSelection?.configName,
    primaryAgent: { modelConfig: currentModelConfig ?? { provider: "", model: "" } },
  };
}

function createInitialWizardProviders(): Map<string, ProviderEntry> {
  const providers = new Map<string, ProviderEntry>();

  for (const preset of PROVIDER_PRESETS) {
    if (preset.localServer) continue;
    if (isManagedProvider(preset.id)) {
      if (hasManagedCredential(preset.id)) {
        providers.set(preset.id, { api_key_env: preset.envVar });
      }
      continue;
    }
    if (process.env[preset.envVar]) {
      providers.set(preset.id, { api_key_env: preset.envVar });
    }
  }

  return providers;
}

function resolveWizardModelSelection(target: string): ModelSelection {
  const parsed = parseProviderModelTarget(target);
  if (!parsed) {
    throw new Error(`Unexpected model picker value: ${target}`);
  }

  const presetModel = PROVIDER_PRESETS
    .find((preset) => preset.id === parsed.provider)
    ?.models.find((model) => model.key === parsed.model);
  const modelId = presetModel?.id ?? parsed.model;

  return {
    configName: `${parsed.provider}:${parsed.model}`,
    providerId: parsed.provider,
    selectionKey: parsed.model,
    modelId,
  };
}

function describeWizardModelSelection(selection: ModelSelection): string {
  const description = describeModel({
    providerId: selection.providerId,
    selectionKey: selection.selectionKey,
    modelId: selection.modelId,
    configName: selection.configName,
  });
  return description.scopedDetailedLabel || selection.configName;
}

function buildWizardModelPickerTree(
  configuredProviders: Map<string, ProviderEntry>,
  currentSelection?: ModelSelection,
  opts?: {
    allowedProviderIds?: Iterable<string>;
    includeLocalDiscoverActions?: boolean;
  },
): ModelPickerTreeNode[] {
  return buildModelPickerTree({
    session: createWizardPickerSession(configuredProviders, currentSelection),
    allowedProviderIds: opts?.allowedProviderIds,
    includeAddProviderAction: false,
    includeLocalDiscoverActions: opts?.includeLocalDiscoverActions,
  });
}

async function stepPickTierModelFromTree(
  configuredProviders: Map<string, ProviderEntry>,
  tierName: "high" | "medium" | "low",
): Promise<ModelSelection | undefined> {
  while (true) {
    const tree = buildWizardModelPickerTree(configuredProviders, undefined, {
      includeLocalDiscoverActions: true,
    });
    if (tree.length === 0) return undefined;

    const picked = await selectTreeStep(tree, `  ${tierName} tier: Select model`);
    if (picked === BACK) return undefined;

    if (picked.endsWith(":__discover__")) {
      const providerId = picked.split(":")[0];
      const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === providerId);
      if (!preset) continue;
      console.log();
      const result = await stepConfigureProvider(preset);
      if (!result.skipped) {
        configuredProviders.set(result.providerId, result.providerEntry);
        if (result.providerEntry.model) {
          return resolveWizardModelSelection(`${result.providerId}:${result.providerEntry.model}`);
        }
      }
      continue;
    }

    const modelSelection = resolveWizardModelSelection(picked);
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === modelSelection.providerId);
    if (preset && !isProviderConfigured(preset, configuredProviders)) {
      console.log();
      const result = await stepConfigureProvider(preset);
      if (result.skipped) continue;
      configuredProviders.set(result.providerId, result.providerEntry);
    }

    return modelSelection;
  }
}

function describeTierEntry(entry: ModelTierEntry): string {
  const description = describeModel({
    providerId: entry.provider,
    selectionKey: entry.selection_key,
    modelId: entry.model_id,
    configName: `${entry.provider}:${entry.selection_key}`,
  });
  return description.scopedDetailedLabel || `${entry.provider}:${entry.selection_key}`;
}

// ------------------------------------------------------------------
// Step: Configure a single provider (reused from old wizard)
// ------------------------------------------------------------------

async function stepConfigureProvider(provider: ProviderPreset): Promise<ProviderConfigResult> {
  // 鈹€鈹€ OpenAI Codex (OAuth) 鈹€鈹€
  if (provider.id === "openai-codex") {
    console.log(`  ${provider.name}: Logging in with your ChatGPT account...\n`);
    const { browserLogin, deviceCodeLogin, saveOAuthTokens, hasOAuthTokens } = await import("./auth/openai-oauth.js");
    if (hasOAuthTokens()) {
      const reuse = await confirm({
        message: "Existing OAuth login found. Use it?",
        default: true,
      });
      if (!reuse) {
        const method = await select({
          message: "Login method",
          choices: [
            { name: "Browser login (recommended)", value: "browser" },
            { name: "Device code (SSH / headless)", value: "device" },
          ],
        });
        const tokens = method === "browser" ? await browserLogin() : await deviceCodeLogin();
        saveOAuthTokens(tokens);
        console.log("\n  Login successful!\n");
      }
    } else {
      const method = await select({
        message: "Login method",
        choices: [
          { name: "Browser login (recommended)", value: "browser" },
          { name: "Device code (SSH / headless)", value: "device" },
        ],
      });
      const tokens = method === "browser" ? await browserLogin() : await deviceCodeLogin();
      saveOAuthTokens(tokens);
      console.log("\n  Login successful!\n");
    }
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: "_OPENAI_CODEX_OAUTH" },
    };
  }

  // 鈹€鈹€ GitHub Copilot (device flow) 鈹€鈹€
  if (provider.id === "copilot") {
    console.log(`  ${provider.name}: Logging in with your GitHub account...\n`);
    const { deviceCodeLoginCLI, saveGitHubTokens, hasGitHubTokens } = await import("./auth/github-copilot-oauth.js");
    if (hasGitHubTokens()) {
      const reuse = await confirm({
        message: "Existing GitHub Copilot login found. Use it?",
        default: true,
      });
      if (!reuse) {
        const tokens = await deviceCodeLoginCLI();
        saveGitHubTokens(tokens);
        console.log("\n  Login successful!\n");
      }
    } else {
      const tokens = await deviceCodeLoginCLI();
      saveGitHubTokens(tokens);
      console.log("\n  Login successful!\n");
    }
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: "_COPILOT_OAUTH" },
    };
  }

  // 鈹€鈹€ Local inference servers (Ollama, oMLX, LM Studio) 鈹€鈹€
  if (provider.localServer && provider.defaultBaseUrl) {
    console.log(`  Default: ${provider.defaultBaseUrl} (press Enter to use)\n`);
    const baseUrl = await input({
      message: `${provider.name}: Server URL`,
      default: provider.defaultBaseUrl,
    });

    // Try without key first; if no models found, ask for API key and retry
    console.log(`  Connecting to ${baseUrl} ...`);
    let apiKey = "local";
    let discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
    if (discovered.length === 0) {
      const keyInput = await input({
        message: `${provider.name}: API key (Enter to skip if none required)`,
      });
      if (keyInput.trim()) {
        apiKey = keyInput.trim();
        discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
      }
    }

    let modelId: string;
    let contextLength: number | undefined;

    if (discovered.length > 0) {
      console.log(`  Found ${discovered.length} model(s)\n`);
      modelId = await select({
        message: `${provider.name}: Select model`,
        choices: discovered.map((m) => ({
          name: m.contextLength
            ? `${m.id} (${Math.round(m.contextLength / 1024)}K ctx)`
            : m.id,
          value: m.id,
        })),
      });
      contextLength = discovered.find((m) => m.id === modelId)?.contextLength;
    } else {
      console.log(
        "  Could not reach server or no models loaded.\n" +
        "  Please make sure the server is running and has at least one model loaded.\n",
      );
      modelId = await input({
        message: `${provider.name}: Enter model name manually`,
      });
    }

    if (!contextLength) {
      const ctxInput = await input({
        message: `${provider.name}: Context length (tokens, e.g. 32768)`,
        default: "32768",
      });
      contextLength = parseInt(ctxInput, 10) || 32768;
    }

    const entry: ProviderEntry = { base_url: baseUrl, model: modelId, context_length: contextLength };
    if (apiKey !== "local") entry.api_key = apiKey;

    return { providerId: provider.id, providerEntry: entry };
  }

  // 鈹€鈹€ Managed credential providers (Kimi, GLM, MiniMax) 鈹€鈹€
  if (isManagedProvider(provider.id)) {
    const result = await ensureManagedProviderCredential(
      provider.id,
      createInitPromptAdapter(),
      { mode: "init", allowReplaceExisting: true },
    );
    if (result.status === "skipped") {
      return { providerId: provider.id, providerEntry: { api_key_env: result.envVar }, skipped: true };
    }

    console.log(`  鉁?Saved to ~/.swarmflow/.env as ${result.envVar}\n`);
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: result.envVar },
    };
  }

  // 鈹€鈹€ Standard API key providers 鈹€鈹€
  const envVarName = provider.envVar;
  const envValue = process.env[envVarName];

  if (envValue) {
    const choice = await select({
      message: `${provider.name}: ${envVarName} detected in environment`,
      choices: [
        { name: "Use it", value: "use" },
        { name: "Paste a different key for swarmflow", value: "paste" },
      ],
    });
    if (choice === "paste") {
      const key = await input({ message: `${provider.name}: Paste API key` });
      if (key.trim()) {
        setDotenvKey(envVarName, key.trim());
        console.log(`  鉁?Saved to ~/.swarmflow/.env\n`);
      }
    }
  } else {
    const key = await input({
      message: `${provider.name}: Paste API key (Enter to skip, set ${envVarName} later)`,
    });
    if (key.trim()) {
      setDotenvKey(envVarName, key.trim());
      console.log(`  鉁?Saved to ~/.swarmflow/.env\n`);
    }
  }

  return {
    providerId: provider.id,
    providerEntry: { api_key_env: envVarName },
  };
}

// ------------------------------------------------------------------
// Staged model-config flow: endpoint 鈫?API key 鈫?model. Each stage returns
// "next" or BACK; the linear driver steps back exactly one stage on BACK.
// ------------------------------------------------------------------

interface WizardCtx {
  providers: Map<string, ProviderEntry>;
  selectedProviderId?: string;
  modelSelection?: ModelSelection;
  /** True when the endpoint's configure stage already picked the model (local). */
  modelPickedDuringConfigure: boolean;
  thinkingLevel?: string;
  tierConfig?: Record<string, ModelTierEntry>;
}

interface WizardStage {
  name: string;
  applicable?: (ctx: WizardCtx) => boolean;
  run: (ctx: WizardCtx) => Promise<"next" | Back>;
}

/**
 * Run stages in order. BACK steps to the previous *applicable* stage (skipping
 * inapplicable ones in both directions). Backing out of the first stage returns
 * false (caller decides whether that means "cancel" or "re-show check-existing").
 */
async function runStages(stages: WizardStage[], ctx: WizardCtx): Promise<boolean> {
  let i = 0;
  while (i < stages.length) {
    const stage = stages[i];
    if (stage.applicable && !stage.applicable(ctx)) { i++; continue; }
    const outcome = await stage.run(ctx);
    if (outcome === BACK) {
      let j = i - 1;
      while (j >= 0 && stages[j].applicable && !stages[j].applicable!(ctx)) j--;
      if (j < 0) return false;
      i = j;
    } else {
      i++;
    }
  }
  return true;
}

function endpointDisplayLabel(providerId: string): string {
  const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
  if (preset) {
    return describeModel({ providerId, selectionKey: providerId, modelId: providerId }).providerLabel
      ?? preset.subLabel ?? preset.name;
  }
  return loadGlobalSettings().providers?.[providerId]?.label ?? providerId;
}

/**
 * Find the *provider* node (the one whose children are models/vendors) for an
 * endpoint. Matches kind "provider" so a group node sharing its id with its
 * first sub-provider (e.g. the "kimi" group vs the "kimi" endpoint) doesn't
 * shadow the real endpoint.
 */
function findProviderNode(nodes: ModelPickerTreeNode[], id: string): ModelPickerTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id && node.kind === "provider") return node;
    if (node.children) {
      const found = findProviderNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Model (or vendor鈫抦odel) children for one endpoint, minus action nodes. */
function modelChoicesForProvider(
  providers: Map<string, ProviderEntry>,
  providerId: string,
): ModelPickerTreeNode[] {
  const tree = buildWizardModelPickerTree(providers, undefined, { includeLocalDiscoverActions: false });
  const node = findProviderNode(tree, providerId);
  if (!node?.children) return [];
  return node.children.filter((child) => child.kind !== "action");
}

/** Endpoint 鈫?API key sub-flow. Screen A (keep/replace/import); Screen B (paste). */
async function runKeySubflow(slot: CredentialSlot): Promise<"done" | Back> {
  while (true) {
    const configured = isCredentialConfigured(slot);
    const candidates = credentialImportCandidates(slot);
    const choices: SelectStepChoice[] = [];
    if (configured) {
      const cur = currentCredentialKey(slot);
      choices.push({ name: `Keep current key (${cur ? maskKey(cur) : "saved"})`, value: "keep" });
      choices.push({ name: "Replace with a new key", value: "replace" });
    } else {
      choices.push({ name: "Paste a key", value: "replace" });
    }
    for (const candidate of candidates) {
      choices.push({ name: `Import detected ${candidate.envVar}`, value: `import:${candidate.envVar}` });
    }

    const action = await selectStep({ message: `${slot.label}: API key`, choices });
    if (action === BACK) return BACK;
    if (action === "keep") return "done";
    if (action.startsWith("import:")) {
      const candidate = candidates.find((c) => `import:${c.envVar}` === action);
      if (candidate) {
        setCredentialKey(slot, candidate.value);
        return "done";
      }
      continue;
    }

    // action === "replace" 鈫?paste screen; Esc here returns to the menu above.
    let backedOut = false;
    while (true) {
      const pasted = await inputStep({ message: `${slot.label}: Paste API key` });
      if (pasted === BACK) { backedOut = true; break; }
      if (pasted.trim() === "") continue;
      setCredentialKey(slot, pasted.trim());
      return "done";
    }
    if (backedOut) continue;
  }
}

async function stageSelectEndpoint(ctx: WizardCtx): Promise<"next" | Back> {
  const tree = buildCredentialEndpointTree(
    { session: createWizardPickerSession(ctx.providers) },
    { includeOAuthAndLocal: true },
  );
  const picked = await selectTreeStep(tree, "Select a provider");
  if (picked === BACK) return BACK;
  ctx.selectedProviderId = picked;
  return "next";
}

async function stageConfigureEndpoint(ctx: WizardCtx): Promise<"next" | Back> {
  const providerId = ctx.selectedProviderId!;
  ctx.modelSelection = undefined;
  ctx.modelPickedDuringConfigure = false;

  const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
  const kind = providerCredentialKind(providerId);

  // OAuth / local providers keep the existing multi-prompt sub-flow.
  if (preset && (preset.localServer || kind === "oauth")) {
    let result: ProviderConfigResult;
    try {
      console.log();
      result = await stepConfigureProvider(preset);
    } catch (err) {
      if (isUserCancel(err)) return BACK;
      throw err;
    }
    if (result.skipped) return BACK;
    ctx.providers.set(result.providerId, result.providerEntry);
    if (result.providerEntry.model) {
      ctx.modelSelection = {
        configName: `${result.providerId}:${result.providerEntry.model}`,
        providerId: result.providerId,
        selectionKey: result.providerEntry.model,
        modelId: result.providerEntry.model,
      };
      ctx.modelPickedDuringConfigure = true;
    }
    return "next";
  }

  // Keyed provider (env / managed / custom) 鈫?key sub-flow.
  const slot = resolveCredentialSlot(providerId, { label: endpointDisplayLabel(providerId) });
  if (!slot) {
    ctx.providers.set(providerId, {});
    return "next";
  }
  const outcome = await runKeySubflow(slot);
  if (outcome === BACK) return BACK;
  ctx.providers.set(providerId, { api_key_env: slot.envVar });
  return "next";
}

async function stageSelectModel(ctx: WizardCtx): Promise<"next" | Back> {
  const providerId = ctx.selectedProviderId!;
  const choices = modelChoicesForProvider(ctx.providers, providerId);
  if (choices.length === 0) {
    console.log("  No models available for this endpoint.\n");
    return BACK;
  }
  const picked = await selectTreeStep(choices, `${endpointDisplayLabel(providerId)}: Select model`);
  if (picked === BACK) return BACK;
  ctx.modelSelection = resolveWizardModelSelection(picked);
  return "next";
}

async function stageThinkingLevel(ctx: WizardCtx): Promise<"next" | Back> {
  const modelId = ctx.modelSelection?.modelId;
  if (!modelId) { ctx.thinkingLevel = undefined; return "next"; }
  const levels = getThinkingLevels(modelId);
  if (levels.length === 0) { ctx.thinkingLevel = undefined; return "next"; }
  const choices: SelectStepChoice[] = [];
  if (!levels.includes("off") && !levels.includes("none")) choices.push({ name: "off", value: "off" });
  for (const level of levels) choices.push({ name: level, value: level });
  const sel = await selectStep({ message: "Main model: Thinking level", choices });
  if (sel === BACK) return BACK;
  ctx.thinkingLevel = sel;
  return "next";
}

async function stageConfigureTiers(ctx: WizardCtx): Promise<"next" | Back> {
  const want = await confirmStep({
    message: "Configure sub-agent model tiers? (Skip = all inherit main model)",
    default: false,
  });
  if (want === BACK) return BACK;
  if (!want) { ctx.tierConfig = undefined; return "next"; }
  ctx.tierConfig = await collectTiers(ctx.providers);
  return "next";
}

// ------------------------------------------------------------------
// Sub-agent tier collection (after the top-level "configure tiers?" confirm)
// ------------------------------------------------------------------

async function collectTiers(
  mainProviders: Map<string, ProviderEntry>,
): Promise<Record<string, ModelTierEntry> | undefined> {
  const tiers: Record<string, ModelTierEntry> = {};
  try {
    for (const tierName of ["high", "medium", "low"] as const) {
      const want = await confirmStep({
        message: `  ${tierName} tier: Configure? (No = inherit main model)`,
        default: false,
      });
      if (want === BACK) break;
      if (!want) continue;

      const picked = await stepPickTierModelFromTree(mainProviders, tierName);
      if (!picked) {
        console.log("    No model selected. Skipping.\n");
        continue;
      }

      // Tier-eligible levels exclude native "off" / "none" 鈥?sub-agent tiers
      // always have thinking enabled.
      let thinkingLevel: string;
      if (getThinkingLevels(picked.modelId).length === 0) {
        thinkingLevel = "none";
      } else {
        const eligible = getTierEligibleThinkingLevels(picked.modelId);
        if (eligible.length === 0) {
          console.log(`    Model has no eligible thinking levels (only off/none). Skipping ${tierName} tier.\n`);
          continue;
        }
        const lvl = await selectStep({
          message: `  ${tierName} tier: Thinking level (required)`,
          choices: eligible.map((l) => ({ name: l, value: l })),
        });
        if (lvl === BACK) continue;
        thinkingLevel = lvl;
      }

      tiers[tierName] = createModelTierEntry({
        provider: picked.providerId,
        selectionKey: picked.selectionKey,
        modelId: picked.modelId,
      }, thinkingLevel);
    }
  } catch (err) {
    if (!isUserCancel(err)) throw err;
  }

  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

// ------------------------------------------------------------------
// Step: Web search API key
// ------------------------------------------------------------------

const SEARCH_API_OPTIONS = [
  { env: "SERPER_API_KEY",        name: "Serper",       url: "https://serper.dev",             free: "2,500 queries/month" },
  { env: "TAVILY_API_KEY",        name: "Tavily",       url: "https://tavily.com",             free: "1,000 queries/month" },
  { env: "EXA_API_KEY",           name: "Exa",          url: "https://exa.ai",                 free: "one-time credit" },
  { env: "BRAVE_SEARCH_API_KEY",  name: "Brave Search", url: "https://brave.com/search/api/",  free: "$5 credit" },
] as const;

async function stageWebSearch(_ctx: WizardCtx): Promise<"next" | Back> {
  const configured = SEARCH_API_OPTIONS.find(({ env }) => process.env[env]?.trim());
  if (configured) {
    console.log(`  鉁?Web search: ${configured.name} (${configured.env} detected)\n`);
    return "next";
  }

  const choice = await selectStep({
    message: "Web search: Paste an API key for better results (strongly recommended)",
    choices: [
      ...SEARCH_API_OPTIONS.map((opt) => ({
        name: `${opt.name} 鈥?${opt.free} free 鈫?${opt.url}`,
        value: opt.env,
      })),
      { name: "Skip (use built-in free search 鈥?limited quality)", value: "skip" },
    ],
  });

  if (choice === BACK) return BACK;
  if (choice === "skip") {
    console.log("  Using built-in search (Exa 鈫?Parallel 鈫?DuckDuckGo).\n");
    return "next";
  }

  const selected = SEARCH_API_OPTIONS.find(({ env }) => env === choice)!;
  console.log(`\n  Sign up at ${selected.url} and copy your API key.\n`);

  const key = await inputStep({ message: `Paste your ${selected.env}` });
  if (key === BACK) return BACK;

  if (key.trim()) {
    setDotenvKey(selected.env, key.trim());
    console.log(`  鉁?Saved to ~/.swarmflow/.env\n`);
  } else {
    console.log("  Skipped. You can set it later in ~/.swarmflow/.env\n");
  }
  return "next";
}

// ------------------------------------------------------------------
// Main wizard 鈥?linear stage driver with single-step Esc back
// ------------------------------------------------------------------

export async function runInitWizard(): Promise<WizardResult> {
  const homeDir = getSwarmflowHomeDir();

  // Check if settings.json already exists with providers
  const existingSettings = loadGlobalSettings(homeDir);
  const hasExisting = Boolean(
    existingSettings.providers && Object.keys(existingSettings.providers).length > 0,
  ) || hasAnyManagedCredential();

  console.log();
  console.log("  鈺斺晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晽");
  console.log("  鈺?      Welcome to swarmflow Setup!        鈺?);
  console.log("  鈺氣晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨暆");
  console.log("  (Esc or Ctrl+C: go back one step; back out of the first step to cancel)\n");

  const ctx: WizardCtx = {
    providers: createInitialWizardProviders(),
    modelPickedDuringConfigure: false,
  };

  const stages: WizardStage[] = [
    { name: "endpoint", run: stageSelectEndpoint },
    { name: "configure", run: stageConfigureEndpoint },
    { name: "model", applicable: (c) => !c.modelPickedDuringConfigure, run: stageSelectModel },
    { name: "thinking", run: stageThinkingLevel },
    { name: "tiers", run: stageConfigureTiers },
    { name: "websearch", run: stageWebSearch },
  ];

  while (true) {
    if (hasExisting) {
      const use = await confirmStep({ message: "Existing configuration found. Use it?", default: true });
      if (use === BACK) {
        console.log("\n  Setup cancelled.\n");
        process.exit(0);
      }
      if (use) {
        console.log("\n  鉁?Using existing configuration.\n");
        return { homeDir };
      }
    }

    const completed = await runStages(stages, ctx);
    if (completed) break;

    // Backed out of the first stage.
    if (hasExisting) {
      console.log();
      continue; // re-show "use existing?"
    }
    console.log("\n  Setup cancelled.\n");
    process.exit(0);
  }

  const modelSelection = ctx.modelSelection;
  const configuredProviders = ctx.providers;
  const thinkingLevel = ctx.thinkingLevel;
  const tierConfig = ctx.tierConfig;

  // ------------------------------------------------------------------
  // Build and save settings
  // ------------------------------------------------------------------

  const providers: Record<string, ProviderEntry> = {};
  configuredProviders.forEach((entry, id) => {
    providers[id] = entry;
  });

  const settings: SwarmflowSettings = {
    // Note: do NOT write `default_model` here. `default_model` is a declarative
    // pin that overrides state/model-selection.json on every startup (see
    // bootstrap.ts), so auto-populating it from the wizard's initial pick would
    // make `/model` switches never stick across restarts. The initial selection
    // is persisted to model-selection.json below 鈥?that is the auto-memory.
    // `default_model` stays opt-in: only present if the user adds it by hand.
    thinking_level: thinkingLevel && thinkingLevel !== "off" && thinkingLevel !== "none"
      ? thinkingLevel
      : undefined,
    providers: Object.keys(providers).length > 0 ? providers : undefined,
    model_tiers: tierConfig,
  };

  saveSettings(settings, globalSettingsPath(homeDir));

  // Save model selection state
  if (modelSelection) {
    saveModelSelectionState({
      config_name: modelSelection.configName,
      provider: modelSelection.providerId,
      selection_key: modelSelection.selectionKey,
      model_id: modelSelection.modelId,
      thinking_level: thinkingLevel,
    });
  }

  // Ensure user override directories and global memory file
  mkdirSync(join(homeDir, "prompts", "templates"), { recursive: true });
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  const globalAgentsMd = join(homeDir, "AGENTS.md");
  if (!existsSync(globalAgentsMd)) {
    writeFileSync(globalAgentsMd, "");
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  console.log();
  console.log("  鉁?Configuration saved");
  console.log(`    Settings: ${globalSettingsPath(homeDir)}`);
  console.log();

  if (modelSelection) {
    console.log(`  Default model: ${describeWizardModelSelection(modelSelection)}`);
  }
  if (thinkingLevel && thinkingLevel !== "off" && thinkingLevel !== "none") {
    console.log(`  Thinking level: ${thinkingLevel}`);
  }
  if (tierConfig) {
    for (const [tier, entry] of Object.entries(tierConfig)) {
      console.log(`  ${tier} tier: ${describeTierEntry(entry)}${entry.thinking_level ? ` (thinking: ${entry.thinking_level})` : ""}`);
    }
  }

  console.log();
  configuredProviders.forEach((entry, id) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (entry.base_url) {
      console.log(`  鉁?${preset?.name ?? id} (local: ${entry.base_url})`);
    } else if (entry.api_key_env) {
      const hasKey = isManagedProvider(id)
        ? hasManagedCredential(id)
        : Boolean(process.env[entry.api_key_env]);
      console.log(`  ${hasKey ? "鉁? : "鉁?} ${preset?.name ?? id} (${entry.api_key_env}${hasKey ? "" : " 鈥?not set"})`);
    }
  });

  console.log();
  console.log("  Run 'swarmflow' to start.");
  console.log();

  return { homeDir };
}
