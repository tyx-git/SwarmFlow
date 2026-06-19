import { setDotenvKey, unsetDotenvKey } from "./lifecycle/dotenv.js";
import {
  type DetectedCredentialCandidate,
  detectManagedCredentialCandidates,
  getManagedCredentialSpec,
  isManagedProvider,
  providerCredentialKind,
} from "./config/managed-provider-credentials.js";
import { findProviderPreset } from "./providers/presets.js";
import { loadGlobalSettings, saveGlobalSettingsPatch } from "./config/persistence.js";

export interface PromptChoice {
  label: string;
  value: string;
  description?: string;
}

export interface PromptSelectRequest {
  message: string;
  options: PromptChoice[];
}

export interface PromptSecretRequest {
  message: string;
  allowEmpty?: boolean;
}

export interface CredentialPromptAdapter {
  select(request: PromptSelectRequest): Promise<string | undefined>;
  secret(request: PromptSecretRequest): Promise<string | undefined>;
}

// ------------------------------------------------------------------
// 凭据槽位 — 一个独立于提供者的抽象，涵盖三个
// 密钥可以存放的位置（注册表 `env` 变量、管理式内部变量或
// 自定义提供者的 SWARMFLOW_CUSTOM_* 变量）。OAuth 和本地提供者没有
// 可管理的密钥，返回 `undefined`。
// ------------------------------------------------------------------

export type CredentialSlotKind = "env" | "managed" | "custom";

export interface CredentialSlot {
  providerId: string;
  kind: CredentialSlotKind;
  /** 保存密钥的 ~/.swarmflow/.env 变量。 */
  envVar: string;
  /** 人类友好的提供者标签。 */
  label: string;
}

/** 自定义提供者用于存储密钥的确定性 env 变量名。 */
export function customProviderEnvVar(providerId: string): string {
  return `SWARMFLOW_CUSTOM_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

function providerLabel(providerId: string): string {
  return findProviderPreset(providerId)?.name ?? providerId;
}

/**
 * 解析提供者的凭据槽位，如果没有可管理的密钥则返回 undefined
 *（OAuth/本地）。自定义（非注册表）提供者映射到
 * SWARMFLOW_CUSTOM_* 槽位；传递 `opts.label` 以获得友好的显示名称。
 */
export function resolveCredentialSlot(
  providerId: string,
  opts?: { label?: string },
): CredentialSlot | undefined {
  if (isManagedProvider(providerId)) {
    const spec = getManagedCredentialSpec(providerId);
    if (!spec) return undefined;
    return { providerId, kind: "managed", envVar: spec.internalEnvVar, label: providerLabel(providerId) };
  }

  const kind = providerCredentialKind(providerId);
  if (kind === "env") {
    const preset = findProviderPreset(providerId);
    if (!preset) return undefined;
    return { providerId, kind: "env", envVar: preset.envVar, label: preset.name };
  }
  if (kind === "oauth" || kind === "local") {
    return undefined;
  }

  // 不在注册表中 → 用户定义的自定义提供者。
  return {
    providerId,
    kind: "custom",
    envVar: customProviderEnvVar(providerId),
    label: opts?.label ?? providerId,
  };
}

/** 当前槽位的密钥值（修整后非空），或 undefined。 */
export function currentCredentialKey(slot: CredentialSlot): string | undefined {
  const raw = process.env[slot.envVar];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export function isCredentialConfigured(slot: CredentialSlot): boolean {
  return currentCredentialKey(slot) !== undefined;
}

/** 可导入的 shell候选项（仅限托管提供者）。 */
export function credentialImportCandidates(slot: CredentialSlot): DetectedCredentialCandidate[] {
  return slot.kind === "managed" ? detectManagedCredentialCandidates(slot.providerId) : [];
}

/** 遮蔽密钥以用于显示，例如 "ends —3f9"。 */
export function maskKey(key: string): string {
  const tail = key.trim().slice(-4);
  return tail ? `ends —{tail}` : "saved";
}

function describeCurrentKey(slot: CredentialSlot): string {
  const key = currentCredentialKey(slot);
  return key ? `Keep current key (${maskKey(key)})` : `Continue using ${slot.envVar}`;
}

// ------------------------------------------------------------------
// 写操作 — 写入/删除底层的 .env 变量，对于自定义
// 提供者，保持 settings `${...}` 引用同步。
// ------------------------------------------------------------------

function syncCustomProviderKeyRef(providerId: string, envVar: string, homeDir?: string): void {
  const settings = loadGlobalSettings(homeDir);
  const providers = settings.providers ?? {};
  const entry = providers[providerId];
  if (!entry) return;
  const ref = `\${${envVar}}`;
  if (entry.api_key === ref) return;
  saveGlobalSettingsPatch(
    { providers: { ...providers, [providerId]: { ...entry, api_key: ref } } },
    homeDir,
  );
}

function clearCustomProviderKeyRef(providerId: string, homeDir?: string): void {
  const settings = loadGlobalSettings(homeDir);
  const providers = settings.providers ?? {};
  const entry = providers[providerId];
  if (!entry || entry.api_key === undefined) return;
  const { api_key: _drop, ...rest } = entry;
  saveGlobalSettingsPatch(
    { providers: { ...providers, [providerId]: rest } },
    homeDir,
  );
}

export function setCredentialKey(slot: CredentialSlot, value: string, homeDir?: string): void {
  setDotenvKey(slot.envVar, value.trim(), homeDir);
  if (slot.kind === "custom") syncCustomProviderKeyRef(slot.providerId, slot.envVar, homeDir);
}

export interface RemoveCredentialResult {
  /** 当同名的 shell 变量可能在下次启动时重新提供密钥时为 true。 */

  shellMayResurface: boolean;
}

export function removeCredentialKey(slot: CredentialSlot, homeDir?: string): RemoveCredentialResult {
  unsetDotenvKey(slot.envVar, homeDir);
  if (slot.kind === "custom") clearCustomProviderKeyRef(slot.providerId, homeDir);
// 对于 `env` 提供者，运行时直接读取 env 变量，所以 shell
// 导出相同名称在下一次启动时重新出现。托管/自定义使用
// swarmflow 命名空间的变量，运行时将其视为唯一来源。
  return { shellMayResurface: slot.kind === "env" };
}

// ------------------------------------------------------------------
// Interactive flows
// ------------------------------------------------------------------

export interface EnsureCredentialOptions {
  /** 对于自定义提供者的显示标签（注册表提供者忽略它）。 */
  mode: "init" | "model";
  allowReplaceExisting?: boolean;
  homeDir?: string;

  label?: string;
}

export interface EnsureCredentialResult {
  status: "configured" | "skipped";
  source?: "existing" | "imported" | "pasted";
  envVar: string;
}

// 向后兼容别名（仅托管提供者调用点）。
export type EnsureManagedCredentialOptions = EnsureCredentialOptions;
export type EnsureManagedCredentialResult = EnsureCredentialResult;

async function configureNewKey(
  slot: CredentialSlot,
  adapter: CredentialPromptAdapter,
  options: EnsureCredentialOptions,
  cancelLabel: string,
): Promise<EnsureCredentialResult> {
  const candidates = credentialImportCandidates(slot);
  const choice = await adapter.select({
    message: candidates.length > 0
      ? `${slot.label}: Choose how to configure the API key`
      : `${slot.label}: No saved key found`,
    options: [
      ...candidates.map((candidate) => ({
        label: `Import detected ${candidate.envVar}`,
        value: `import:${candidate.envVar}`,
        description: `Copy ${candidate.envVar} into ${slot.envVar}`,
      })),
      {
        label: "Paste a key",
        value: "paste",
        description: `Save it as ${slot.envVar}`,
      },
      {
        label: cancelLabel,
        value: "cancel",
        description: options.mode === "init"
          ? "Leave this provider unconfigured for now"
          : "Abort model switching",
      },
    ],
  });

  if (!choice || choice === "cancel") {
    return { status: "skipped", envVar: slot.envVar };
  }

  if (choice.startsWith("import:")) {
    const envVar = choice.slice("import:".length);
    const candidate = candidates.find((item) => item.envVar === envVar);
    if (!candidate) {
      throw new Error(`Detected key '${envVar}' is no longer available.`);
    }
    setCredentialKey(slot, candidate.value, options.homeDir);
    return { status: "configured", source: "imported", envVar: slot.envVar };
  }

  while (true) {
    const pasted = await adapter.secret({ message: `${slot.label}: Paste API key`, allowEmpty: false });
    if (pasted === undefined) {
      return { status: "skipped", envVar: slot.envVar };
    }
    if (pasted.trim() === "") continue;
    setCredentialKey(slot, pasted.trim(), options.homeDir);
    return { status: "configured", source: "pasted", envVar: slot.envVar };
  }
}

/**
 * 确保提供者的 API 密钥已配置，可选择替换现有密钥。
 * 由 init（保持/替换，不删除）和 `/model` 在托管凭据缺失时使用。
 * 对于没有可管理密钥的提供者抛出异常。
 */
export async function ensureProviderCredential(
  providerId: string,
  adapter: CredentialPromptAdapter,
  options: EnsureCredentialOptions,
): Promise<EnsureCredentialResult> {
  const slot = resolveCredentialSlot(providerId, { label: options.label });
  if (!slot) {
    throw new Error(`Provider '${providerId}' does not use a manageable API key.`);
  }

  const cancelLabel = options.mode === "init" ? "Skip" : "Cancel";

  if (isCredentialConfigured(slot)) {
    if (!options.allowReplaceExisting) {
      return { status: "configured", source: "existing", envVar: slot.envVar };
    }

    const existingChoice = await adapter.select({
      message: `${slot.label}: An API key is already saved`,
      options: [
        { label: "Keep current key", value: "keep", description: describeCurrentKey(slot) },
        {
          label: "Replace key",
          value: "replace",
          description: slot.kind === "managed"
            ? "Import a detected key or paste a new one"
            : "Paste a new key",
        },
        { label: cancelLabel, value: "cancel", description: "Leave this provider unchanged" },
      ],
    });

    if (existingChoice === "keep") {
      return { status: "configured", source: "existing", envVar: slot.envVar };
    }
    if (!existingChoice || existingChoice === "cancel") {
      return { status: "skipped", envVar: slot.envVar };
    }
  }

  return configureNewKey(slot, adapter, options, cancelLabel);
}

/**
 * 托管提供者调用点的向后兼容包装器。行为与
 * {@link ensureProviderCredential} 完全相同（调用方在 `isManagedProvider` 上进行门控）。
 */
export const ensureManagedProviderCredential = ensureProviderCredential;

// ------------------------------------------------------------------
// 完整的管理流程（`/key` 命令）：设置 / 替换 / 删除 / 导入。
// ------------------------------------------------------------------

export interface ManageCredentialResult {
  status: "configured" | "removed" | "skipped";
  source?: "imported" | "pasted";
  shellMayResurface?: boolean;
  envVar: string;
  label: string;
}

export async function runCredentialManageFlow(
  providerId: string,
  adapter: CredentialPromptAdapter,
  opts?: { homeDir?: string; label?: string },
): Promise<ManageCredentialResult> {
  const slot = resolveCredentialSlot(providerId, { label: opts?.label });
  if (!slot) {
    throw new Error(`Provider '${providerId}' does not use a manageable API key.`);
  }

  const configured = isCredentialConfigured(slot);
  const candidates = credentialImportCandidates(slot);

  const options: PromptChoice[] = [];
  if (configured) {
    options.push({ label: "Replace key", value: "replace", description: describeCurrentKey(slot) });
  } else {
    options.push({ label: "Set key", value: "set", description: `Save it as ${slot.envVar}` });
  }
  for (const candidate of candidates) {
    options.push({
      label: `Import detected ${candidate.envVar}`,
      value: `import:${candidate.envVar}`,
      description: `Copy ${candidate.envVar} into ${slot.envVar}`,
    });
  }
  if (configured) {
    options.push({ label: "Remove key", value: "remove", description: `Delete ${slot.envVar}` });
  }
  options.push({ label: "Cancel", value: "cancel" });

  const action = await adapter.select({ message: `${slot.label} —API key`, options });
  if (!action || action === "cancel") {
    return { status: "skipped", envVar: slot.envVar, label: slot.label };
  }

  if (action.startsWith("import:")) {
    const envVar = action.slice("import:".length);
    const candidate = candidates.find((item) => item.envVar === envVar);
    if (!candidate) {
      throw new Error(`Detected key '${envVar}' is no longer available.`);
    }
    setCredentialKey(slot, candidate.value, opts?.homeDir);
    return { status: "configured", source: "imported", envVar: slot.envVar, label: slot.label };
  }

  if (action === "remove") {
    const confirm = await adapter.select({
      message: `Remove the saved key for ${slot.label}?`,
      options: [
        { label: "Yes, remove it", value: "yes" },
        { label: "Cancel", value: "no" },
      ],
    });
    if (confirm !== "yes") {
      return { status: "skipped", envVar: slot.envVar, label: slot.label };
    }
    const { shellMayResurface } = removeCredentialKey(slot, opts?.homeDir);
    return { status: "removed", shellMayResurface, envVar: slot.envVar, label: slot.label };
  }

  // set / replace →paste loop
  while (true) {
    const pasted = await adapter.secret({ message: `${slot.label}: Paste API key`, allowEmpty: false });
    if (pasted === undefined) {
      return { status: "skipped", envVar: slot.envVar, label: slot.label };
    }
    if (pasted.trim() === "") continue;
    setCredentialKey(slot, pasted.trim(), opts?.homeDir);
    return { status: "configured", source: "pasted", envVar: slot.envVar, label: slot.label };
  }
}
