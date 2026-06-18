/**
 * Single source of truth for model & provider static data.
 *
 * The *schema* and *validator* live here (code, ships with the version). The
 * *data* lives in `assets/model-registry/{models,providers}.json` (pure data,
 * bundled at build time via `import`, and remotely overridable 鈥?see
 * Docs/provider-model-maintainability-plan.md 搂10).
 *
 * Everything the old scattered tables used to hold (KNOWN_* capability tables,
 * PROVIDER_PRESETS, label overrides, default base urls, the three wire-axis
 * switches) is DERIVED from these two registries. Adding a model = one object
 * in models.json; a missing field fails the build-time validator, not silently
 * at runtime.
 */

import factoryModelsRaw from "../assets/model-registry/models.json" with { type: "json" };
import factoryProvidersRaw from "../assets/model-registry/providers.json" with { type: "json" };
import {
  type SealedSchema,
  type ThinkingEncryption,
  type TransportProtocol,
  SEALED_SCHEMA_ANTHROPIC_MESSAGES,
  SEALED_SCHEMA_OPENAI_RESPONSES,
  SEALED_SCHEMA_OPENROUTER_CHAT,
  isAnthropicFamilyModel,
  isOpenAIFamilyModel,
} from "./lib/thinking-artifact.js";

// ------------------------------------------------------------------
// ModelSpec 鈥?one object per model
// ------------------------------------------------------------------

export interface ModelSpec {
  /** Canonical API id (no vendor prefix). Primary capability lookup key. */
  id: string;
  /**
   * Equivalent id spellings used by other providers (e.g. Anthropic-direct
   * `claude-haiku-4-5` vs OpenRouter `claude-haiku-4.5`). All aliases map to
   * this spec's capabilities 鈥?capabilities are described exactly once.
   */
  aliases?: readonly string[];
  /** Human-facing display name, e.g. "GPT-5.4 Mini". The sole label source. */
  displayName: string;
  /** Context window. Required (> 0). */
  contextLength: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  /** Image / multimodal input support. */
  multimodal: boolean;
  /** Available thinking levels; empty (or only ["off"]) 鈬?not a thinking model. */
  thinkingLevels: readonly string[];
  /** Native server-side web search support. Explicit, no default. */
  webSearch: boolean;
  /** OpenAI 24h extended prompt-cache retention. */
  extendedCache?: boolean;
  /**
   * Minimum app (semver) version that can run this entry. Used only by remote
   * delivery: a lower-version swarmflow skips entries it cannot handle. Omitted 鈬?   * available to all versions. (Honored in Phase 6; harmless before then.)
   */
  minAppVersion?: string;
}

/** Shape of `assets/model-registry/models.json`. */
export interface RawModelRegistry {
  schemaVersion: number;
  models: ModelSpec[];
}

export const MODEL_REGISTRY_SCHEMA_VERSION = 1;

const VALID_THINKING_LEVEL = /^[a-z]+$/;

/** All id spellings a spec answers to. */
export function modelSpecIds(spec: ModelSpec): string[] {
  return [spec.id, ...(spec.aliases ?? [])];
}

/** A thinking model = has at least one non-off/none level. */
export function isThinkingSpec(spec: ModelSpec): boolean {
  return spec.thinkingLevels.some((l) => l !== "off" && l !== "none");
}

/**
 * Validate a raw model registry and return its ModelSpec[]. Throws on any
 * structural / invariant violation (factory data 鈫?build-time failure; remote
 * data 鈫?caller rejects and falls back). The error lists ALL problems found,
 * not just the first, so a bad data file is fixed in one pass.
 */
export function loadModelSpecs(raw: unknown): ModelSpec[] {
  const problems: string[] = [];
  const reg = raw as RawModelRegistry;

  if (!reg || typeof reg !== "object" || !Array.isArray(reg.models)) {
    throw new Error("model registry: expected { schemaVersion, models: [...] }");
  }
  if (reg.schemaVersion !== MODEL_REGISTRY_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion ${reg.schemaVersion} != expected ${MODEL_REGISTRY_SCHEMA_VERSION}`,
    );
  }

  const seenIds = new Map<string, string>(); // id spelling -> owning spec id
  for (const [i, spec] of reg.models.entries()) {
    const where = `models[${i}]${spec?.id ? ` (${spec.id})` : ""}`;
    if (!spec || typeof spec !== "object") {
      problems.push(`${where}: not an object`);
      continue;
    }
    if (typeof spec.id !== "string" || spec.id.trim() === "") {
      problems.push(`${where}: missing/empty id`);
    }
    if (typeof spec.displayName !== "string" || spec.displayName.trim() === "") {
      problems.push(`${where}: missing/empty displayName`);
    }
    if (typeof spec.contextLength !== "number" || !(spec.contextLength > 0)) {
      problems.push(`${where}: contextLength must be > 0`);
    }
    if (
      spec.maxOutputTokens !== undefined &&
      (typeof spec.maxOutputTokens !== "number" || !(spec.maxOutputTokens > 0))
    ) {
      problems.push(`${where}: maxOutputTokens must be > 0 when present`);
    }
    if (typeof spec.multimodal !== "boolean") {
      problems.push(`${where}: multimodal must be boolean`);
    }
    if (typeof spec.webSearch !== "boolean") {
      problems.push(`${where}: webSearch must be boolean`);
    }
    if (!Array.isArray(spec.thinkingLevels)) {
      problems.push(`${where}: thinkingLevels must be an array`);
    } else {
      for (const l of spec.thinkingLevels) {
        if (typeof l !== "string" || !VALID_THINKING_LEVEL.test(l)) {
          problems.push(`${where}: invalid thinking level ${JSON.stringify(l)}`);
        }
      }
    }
    if (spec.aliases !== undefined && !Array.isArray(spec.aliases)) {
      problems.push(`${where}: aliases must be an array when present`);
    }
    // Global uniqueness across id + every alias.
    if (typeof spec.id === "string") {
      for (const spelling of modelSpecIds(spec)) {
        const owner = seenIds.get(spelling);
        if (owner !== undefined) {
          problems.push(`${where}: id/alias '${spelling}' collides with '${owner}'`);
        } else {
          seenIds.set(spelling, spec.id);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`model registry invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return reg.models;
}

// ------------------------------------------------------------------
// Capability derivation 鈥?replaces the seven KNOWN_* tables
// ------------------------------------------------------------------

export interface DerivedModelTables {
  contextLengths: Record<string, number>;
  maxOutputTokens: Record<string, number>;
  multimodal: Set<string>;
  thinking: Set<string>;
  thinkingLevels: Record<string, string[]>;
  noWebSearch: Set<string>;
  extendedCache: Set<string>;
  /** canonicalized-id -> displayName, replacing MODEL_LABEL_OVERRIDES. */
  labelOverrides: Record<string, string>;
}

/** Same canonicalization model-presentation uses for MODEL_LABEL_OVERRIDES keys. */
export function canonicalizeModelKey(model: string): string {
  const idx = model.lastIndexOf("/");
  const noPrefix = idx >= 0 ? model.slice(idx + 1) : model;
  return noPrefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build every derived capability table from a ModelSpec[]. */
export function deriveModelTables(specs: readonly ModelSpec[]): DerivedModelTables {
  const tables: DerivedModelTables = {
    contextLengths: {},
    maxOutputTokens: {},
    multimodal: new Set(),
    thinking: new Set(),
    thinkingLevels: {},
    noWebSearch: new Set(),
    extendedCache: new Set(),
    labelOverrides: {},
  };
  for (const spec of specs) {
    const ids = modelSpecIds(spec);
    const thinks = isThinkingSpec(spec);
    for (const id of ids) {
      tables.contextLengths[id] = spec.contextLength;
      if (spec.maxOutputTokens !== undefined) tables.maxOutputTokens[id] = spec.maxOutputTokens;
      if (spec.multimodal) tables.multimodal.add(id);
      if (thinks) tables.thinking.add(id);
      tables.thinkingLevels[id] = [...spec.thinkingLevels];
      if (!spec.webSearch) tables.noWebSearch.add(id);
      if (spec.extendedCache) tables.extendedCache.add(id);
      tables.labelOverrides[canonicalizeModelKey(id)] = spec.displayName;
    }
  }
  return tables;
}

// ------------------------------------------------------------------
// Factory defaults (bundled) + legacy carve-outs
// ------------------------------------------------------------------

/** Factory model specs bundled into the binary. Phase 5 layers remote over this. */
export const FACTORY_MODEL_SPECS: ModelSpec[] = loadModelSpecs(factoryModelsRaw);

/**
 * Derived capability tables for the factory specs. Single shared instance so
 * config.ts and model-presentation.ts don't each re-derive. Phase 5 replaces
 * this with a getter over the live (factory 鈭?remote) effective registry.
 */
export const FACTORY_MODEL_TABLES: DerivedModelTables = deriveModelTables(FACTORY_MODEL_SPECS);

/**
 * Extended-cache-only OpenAI ids that predate the registry: retired models not
 * in any preset and lacking full specs (no context length etc.), kept so a
 * hand-configured settings.json referencing them still reports extended cache.
 * Unioned into KNOWN_EXTENDED_CACHE_MODELS; not part of MODEL_SPECS.
 */
export const LEGACY_EXTENDED_CACHE_IDS: readonly string[] = [
  "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest",
  "gpt-5", "gpt-5-codex", "gpt-4.1",
];

// ------------------------------------------------------------------
// ProviderSpec 鈥?one object per provider
// ------------------------------------------------------------------

/** Which concrete provider class handles this provider (registry dispatch, data-driven). */
export type ProviderClassKind =
  | "anthropic"
  | "openai-responses"
  | "openai-chat"
  | "qwen-responses"
  | "glm"
  | "openrouter"
  | "copilot"
  | "kimi-anthropic"
  | "deepseek-anthropic"
  | "minimax-anthropic"
  | "xiaomi-anthropic";

const PROVIDER_CLASS_KINDS: ReadonlySet<string> = new Set<ProviderClassKind>([
  "anthropic", "openai-responses", "openai-chat", "qwen-responses", "glm",
  "openrouter", "copilot", "kimi-anthropic", "deepseek-anthropic",
  "minimax-anthropic", "xiaomi-anthropic",
]);

/** How a provider's API credential is sourced. One discriminated answer, not a pile of optionals. */
export type CredentialSpec =
  | { kind: "env"; envVar: string }
  | { kind: "managed"; internalEnvVar: string; externalEnvVars: readonly string[] }
  | { kind: "oauth"; flow: "openai-codex" | "copilot"; envVar: string }
  | { kind: "local"; envVar: string };

/**
 * Wire-axis defaults. A concrete value pins the axis; the "by-family" sentinel
 * defers to the model family (Copilot routes Claude vs GPT differently), and
 * "openrouter" pins the OpenRouter Fernet envelope. The resolution rule is
 * data 鈥?the result per model is computed by resolveProviderWireAxes.
 */
export interface WireDefaults {
  transportProtocol: TransportProtocol | "by-family";
  thinkingEncryption: ThinkingEncryption | "by-family";
  sealedSchema: SealedSchema | null | "by-family" | "openrouter";
}

/** A model a provider exposes 鈥?a reference into MODEL_SPECS plus per-entry overrides. */
export interface ProviderModelRef {
  /** API model id sent to the provider; default = spec (e.g. OpenRouter "anthropic/claude-haiku-4.5"). */
  id?: string;
  /** ModelSpec id for capabilities/label; also the default API id. Omit only for spec-less models. */
  spec?: string;
  /** picker selector; default = effective id. */
  key?: string;
  /** display label override; default = referenced spec's displayName. */
  label?: string;
  optionNote?: string;
  aliases?: readonly string[];
  config?: Record<string, unknown>;
}

/** Three-level picker grouping (region/plan families). */
export interface ProviderGroup {
  id: string;
  label: string;
  subLabel: string;
}

export interface ProviderSpec {
  id: string;
  /** Full name for init / error messages, e.g. "Anthropic (Claude)". */
  name: string;
  /** Brand key/label (BRAND_LABEL_OVERRIDES). */
  brand: string;
  /** Picker provider-node label (PROVIDER_LABEL_OVERRIDES). Default derived from name. */
  providerLabel?: string;
  credential: CredentialSpec;
  defaultBaseUrl?: string;
  providerClass: ProviderClassKind;
  wire: WireDefaults;
  group?: ProviderGroup;
  localServer?: boolean;
  models: ProviderModelRef[];
}

export interface RawProviderRegistry {
  schemaVersion: number;
  providers: ProviderSpec[];
}

/** Effective API model id for a ref: explicit id, else the referenced spec id. */
export function providerModelEffectiveId(ref: ProviderModelRef): string {
  return ref.id ?? ref.spec ?? "";
}

/** Effective picker selector key for a ref: explicit key, else effective id. */
export function providerModelKey(ref: ProviderModelRef): string {
  return ref.key ?? providerModelEffectiveId(ref);
}

/** The env var a credential sources its key from (managed 鈫?internal slot). */
export function credentialEnvVar(c: CredentialSpec): string {
  switch (c.kind) {
    case "env": return c.envVar;
    case "managed": return c.internalEnvVar;
    case "oauth": return c.envVar;
    case "local": return c.envVar;
  }
}

/**
 * OpenRouter's vendor-prefix 鈫?our brand label. Irreducible: OpenRouter names
 * vendors differently from us (moonshotai鈮燢imi, z-ai鈮燝LM) and that mapping can't
 * be derived from anything else 鈥?but it lives here, in one place, not scattered.
 */
export const OPENROUTER_VENDOR_BRAND: Record<string, string> = {
  "anthropic": "Anthropic",
  "openai": "OpenAI",
  "qwen": "Qwen",
  "moonshotai": "Kimi",
  "minimax": "MiniMax",
  "z-ai": "GLM / Zhipu",
  "deepseek": "DeepSeek",
  "xiaomi": "MiMo",
};

/**
 * Resolve the three wire axes for a concrete (provider-wire, model) pair,
 * expanding the "by-family" / "openrouter" sentinels. Mirrors the old
 * resolveTransportProtocol / resolveThinkingEncryption / resolveSealedSchema
 * switches exactly 鈥?now driven by ProviderSpec.wire data.
 */
export function resolveProviderWireAxes(
  wire: WireDefaults,
  model: string,
): { transport: TransportProtocol; encryption: ThinkingEncryption; sealedSchema: SealedSchema | null } {
  const transport: TransportProtocol =
    wire.transportProtocol === "by-family"
      ? (isAnthropicFamilyModel(model) ? "anthropic" : "responses")
      : wire.transportProtocol;

  const encryption: ThinkingEncryption =
    wire.thinkingEncryption === "by-family"
      ? (isOpenAIFamilyModel(model)
          ? "openai"
          : isAnthropicFamilyModel(model)
            ? "anthropic"
            : "none")
      : wire.thinkingEncryption;

  let sealedSchema: SealedSchema | null;
  if (wire.sealedSchema === "by-family") {
    sealedSchema = isAnthropicFamilyModel(model)
      ? SEALED_SCHEMA_ANTHROPIC_MESSAGES
      : SEALED_SCHEMA_OPENAI_RESPONSES;
  } else if (wire.sealedSchema === "openrouter") {
    sealedSchema = SEALED_SCHEMA_OPENROUTER_CHAT;
  } else {
    sealedSchema = wire.sealedSchema;
  }

  return { transport, encryption, sealedSchema };
}

/**
 * Validate a raw provider registry and return its ProviderSpec[]. `knownModelIds`
 * is the set of all ModelSpec id+alias spellings, used to check every
 * model.spec reference resolves. Throws listing ALL problems.
 */
export function loadProviderSpecs(raw: unknown, knownModelIds: ReadonlySet<string>): ProviderSpec[] {
  const problems: string[] = [];
  const reg = raw as RawProviderRegistry;

  if (!reg || typeof reg !== "object" || !Array.isArray(reg.providers)) {
    throw new Error("provider registry: expected { schemaVersion, providers: [...] }");
  }
  if (reg.schemaVersion !== MODEL_REGISTRY_SCHEMA_VERSION) {
    problems.push(`schemaVersion ${reg.schemaVersion} != expected ${MODEL_REGISTRY_SCHEMA_VERSION}`);
  }

  const seenProviderIds = new Set<string>();
  for (const [i, p] of reg.providers.entries()) {
    const where = `providers[${i}]${p?.id ? ` (${p.id})` : ""}`;
    if (!p || typeof p !== "object") {
      problems.push(`${where}: not an object`);
      continue;
    }
    if (typeof p.id !== "string" || p.id.trim() === "") problems.push(`${where}: missing/empty id`);
    else if (seenProviderIds.has(p.id)) problems.push(`${where}: duplicate provider id`);
    else seenProviderIds.add(p.id);

    if (typeof p.name !== "string" || p.name.trim() === "") problems.push(`${where}: missing name`);
    if (typeof p.brand !== "string" || p.brand.trim() === "") problems.push(`${where}: missing brand`);
    if (!PROVIDER_CLASS_KINDS.has(p.providerClass)) {
      problems.push(`${where}: unknown providerClass '${p.providerClass}'`);
    }
    if (!p.credential || typeof p.credential !== "object") {
      problems.push(`${where}: missing credential`);
    }
    if (!p.wire || typeof p.wire !== "object") problems.push(`${where}: missing wire`);
    if (!Array.isArray(p.models)) {
      problems.push(`${where}: models must be an array`);
    } else {
      for (const [j, m] of p.models.entries()) {
        const eid = m?.id ?? m?.spec;
        const mw = `${where}.models[${j}]${eid ? ` (${eid})` : ""}`;
        if (!m || typeof eid !== "string" || eid.trim() === "") {
          problems.push(`${mw}: needs id or spec`);
          continue;
        }
        // A ref must resolve a label: either reference a known spec, or carry an explicit label.
        if (m.spec !== undefined) {
          if (!knownModelIds.has(m.spec)) problems.push(`${mw}: spec '${m.spec}' not in model registry`);
        } else if (typeof m.label !== "string" || m.label.trim() === "") {
          problems.push(`${mw}: spec-less model needs an explicit label`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`provider registry invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return reg.providers;
}

// ------------------------------------------------------------------
// Factory provider defaults (bundled)
// ------------------------------------------------------------------

/** All ModelSpec id+alias spellings 鈥?used to validate provider model refs. */
const FACTORY_MODEL_ID_SET: ReadonlySet<string> = new Set(FACTORY_MODEL_SPECS.flatMap(modelSpecIds));

/** Factory provider specs bundled into the binary. Phase 5 layers remote over this. */
export const FACTORY_PROVIDER_SPECS: ProviderSpec[] = loadProviderSpecs(factoryProvidersRaw, FACTORY_MODEL_ID_SET);
