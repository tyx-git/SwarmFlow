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
// Credential slots 鈥?one provider-agnostic abstraction over the three
// places a key can live (a registry `env` var, a managed internal var, or a
// custom provider's SWARMFLOW_CUSTOM_* var). OAuth and local providers have no
// manageable key and resolve to `undefined`.
// ------------------------------------------------------------------

export type CredentialSlotKind = "env" | "managed" | "custom";

export interface CredentialSlot {
  providerId: string;
  kind: CredentialSlotKind;
  /** The ~/.swarmflow/.env variable that holds the key. */
  envVar: string;
  /** Human-friendly provider label. */
  label: string;
}

/** Deterministic env var name a custom provider stores its key under. */
export function customProviderEnvVar(providerId: string): string {
  return `SWARMFLOW_CUSTOM_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

function providerLabel(providerId: string): string {
  return findProviderPreset(providerId)?.name ?? providerId;
}

/**
 * Resolve the credential slot for a provider, or undefined if it has no
 * manageable key (OAuth / local). Custom (non-registry) providers map to a
 * SWARMFLOW_CUSTOM_* slot; pass `opts.label` for a nice display name.
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

  // Not in the registry 鈫?user-defined custom provider.
  return {
    providerId,
    kind: "custom",
    envVar: customProviderEnvVar(providerId),
    label: opts?.label ?? providerId,
  };
}

/** Current key value for a slot (trimmed-nonempty), or undefined. */
export function currentCredentialKey(slot: CredentialSlot): string | undefined {
  const raw = process.env[slot.envVar];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export function isCredentialConfigured(slot: CredentialSlot): boolean {
  return currentCredentialKey(slot) !== undefined;
}

/** Importable shell candidates (managed providers only). */
export function credentialImportCandidates(slot: CredentialSlot): DetectedCredentialCandidate[] {
  return slot.kind === "managed" ? detectManagedCredentialCandidates(slot.providerId) : [];
}

/** Mask a key for display, e.g. "ends 鈥3f9". */
export function maskKey(key: string): string {
  const tail = key.trim().slice(-4);
  return tail ? `ends 鈥?{tail}` : "saved";
}

function describeCurrentKey(slot: CredentialSlot): string {
  const key = currentCredentialKey(slot);
  return key ? `Keep current key (${maskKey(key)})` : `Continue using ${slot.envVar}`;
}

// ------------------------------------------------------------------
// Write ops 鈥?write/remove the underlying .env var and, for custom
// providers, keep the settings `${...}` reference in sync.
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
  /** True when an identically-named shell var may re-provide the key next launch. */
  shellMayResurface: boolean;
}

export function removeCredentialKey(slot: CredentialSlot, homeDir?: string): RemoveCredentialResult {
  unsetDotenvKey(slot.envVar, homeDir);
  if (slot.kind === "custom") clearCustomProviderKeyRef(slot.providerId, homeDir);
  // For `env` providers the runtime reads the env var directly, so a shell
  // export of the same name resurfaces next launch. Managed/custom use a
  // swarmflow-namespaced var that the runtime treats as the sole source.
  return { shellMayResurface: slot.kind === "env" };
}

// ------------------------------------------------------------------
// Interactive flows
// ------------------------------------------------------------------

export interface EnsureCredentialOptions {
  mode: "init" | "model";
  allowReplaceExisting?: boolean;
  homeDir?: string;
  /** Display label for custom providers (registry providers ignore it). */
  label?: string;
}

export interface EnsureCredentialResult {
  status: "configured" | "skipped";
  source?: "existing" | "imported" | "pasted";
  envVar: string;
}

// Back-compat aliases (managed-only call sites).
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
 * Ensure a provider's API key is configured, optionally offering to replace an
 * existing one. Used by init (keep/replace, no removal) and by `/model` when a
 * managed credential is missing. Throws for providers with no manageable key.
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
 * Back-compat wrapper for managed-provider call sites. Behaves identically to
 * {@link ensureProviderCredential} (callers gate on `isManagedProvider`).
 */
export const ensureManagedProviderCredential = ensureProviderCredential;

// ------------------------------------------------------------------
// Full management flow (the `/key` command): set / replace / remove / import.
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

  const action = await adapter.select({ message: `${slot.label} 鈥?API key`, options });
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

  // set / replace 鈫?paste loop
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
