/**
 * 模型和提供者静态数据的单一真实来源。
 *
 * *schema* 和 *validator* 位于此处（代码，随版本发布）。
 * *data* 位于 `assets/model-registry/{models,providers}.json`（纯数据，
 * 在构建时通过 `import` 打包，并且可以远程覆盖 — 参见
 * Docs/provider-model-maintainability-plan.md §10）。
 *
 * 旧分散表曾持有的所有内容（KNOWN_* 能力表、
 * PROVIDER_PRESETS、标签覆盖、默认基础 URL、三个线轴
 * 开关）都从这两个注册表*派生*。添加模型 = models.json 中的一个对象；
 * 缺失字段导致构建时验证器失败，而不是在运行时静默失败。
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
// ModelSpec — 每个模型一个对象
// ------------------------------------------------------------------

export interface ModelSpec {
  /** 规范 API id（无供应商前缀）。主要能力查找键。 */
  id: string;
  /**
   * 其他提供者使用的等效 id 拼写（如 Anthropic 直连
   * `claude-haiku-4-5` vs OpenRouter `claude-haiku-4.5`）。所有别名映射到
   * 此 spec 的能力 — 能力精确描述一次。
   */
  aliases?: readonly string[];
  /** 面向人类的显示名称，如 "GPT-5.4 Mini"。唯一标签来源。 */
  displayName: string;
  /** 上下文窗口。必需（> 0）。 */
  contextLength: number;
  /** 最大输出 token 数。 */
  maxOutputTokens?: number;
  /** 图片/多模态输入支持。 */
  multimodal: boolean;
  /** 可用的思考级别；空（或只有 ["off"]）— 不是思考模型。 */
  thinkingLevels: readonly string[];
  /** 原生服务端 Web 搜索支持。显式，无默认值。 */
  webSearch: boolean;
  /** OpenAI 24 小时扩展 prompt 缓存保留。 */
  extendedCache?: boolean;
  /**
   * 可以运行此条目的最小应用（semver）版本。仅用于远程
   * 传递：较低版本的 swarmflow 会跳过其无法处理的条目。省略 —
   * 对所有版本可用。（在第 6 阶段生效；之前无害。）
   */
  minAppVersion?: string;
}

/** `assets/model-registry/models.json` 的形状。 */
export interface RawModelRegistry {
  schemaVersion: number;
  models: ModelSpec[];
}

export const MODEL_REGISTRY_SCHEMA_VERSION = 1;

const VALID_THINKING_LEVEL = /^[a-z]+$/;

/** spec 回答的所有 id 拼写。 */
export function modelSpecIds(spec: ModelSpec): string[] {
  return [spec.id, ...(spec.aliases ?? [])];
}

/** 思考模型 = 至少有一个非 off/none 级别。 */
export function isThinkingSpec(spec: ModelSpec): boolean {
  return spec.thinkingLevels.some((l) => l !== "off" && l !== "none");
}

/**
 * 验证原始模型注册表并返回其 ModelSpec[]。在任何
 * 结构/不变量违反时抛出（工厂数据 → 构建时失败；
 * 远程数据 → 调用者拒绝并回退）。错误列出*所有*发现的问题，
 * 而不仅仅是第一个，所以坏的数据文件可以一次修复。
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

  const seenIds = new Map<string, string>(); // id 拼写 -> 拥有的 spec id
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
    // 跨 id + 每个别名的全局唯一性
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
// 能力派生 — 替换七个 KNOWN_* 表
// ------------------------------------------------------------------

export interface DerivedModelTables {
  contextLengths: Record<string, number>;
  maxOutputTokens: Record<string, number>;
  multimodal: Set<string>;
  thinking: Set<string>;
  thinkingLevels: Record<string, string[]>;
  noWebSearch: Set<string>;
  extendedCache: Set<string>;
  /** 规范化 id -> displayName，替换 MODEL_LABEL_OVERRIDES */
  labelOverrides: Record<string, string>;
}

/** model-presentation 用于 MODEL_LABEL_OVERRIDES 键的相同规范化模型 */
export function canonicalizeModelKey(model: string): string {
  const idx = model.lastIndexOf("/");
  const noPrefix = idx >= 0 ? model.slice(idx + 1) : model;
  return noPrefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 从 ModelSpec[] 构建每个派生能力表 */
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
// 工厂默认值（打包）+ 遗留例外
// ------------------------------------------------------------------

/** 打包到二进制中的工厂模型 spec。第 5 阶段在此之上分层远程。 */
export const FACTORY_MODEL_SPECS: ModelSpec[] = loadModelSpecs(factoryModelsRaw);

/**
 * 工厂 spec 的派生能力表。单一共享实例，
 * config.ts 和 model-presentation.ts 不会各自重新派生。
 * 第 5 阶段用活动（工厂 — 远程）有效注册表上的 getter 替换此。
 */
export const FACTORY_MODEL_TABLES: DerivedModelTables = deriveModelTables(FACTORY_MODEL_SPECS);

/**
 * 早于注册表的扩展缓存专用 OpenAI id：不在任何预设中的已停用模型
 * 且缺少完整 spec（无上下文长度等），保留以便引用它们的
 * 手动配置的 settings.json 仍然报告扩展缓存。
 * 联合到 KNOWN_EXTENDED_CACHE_MODELS；不属于 MODEL_SPECS。
 */
export const LEGACY_EXTENDED_CACHE_IDS: readonly string[] = [
  "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest",
  "gpt-5", "gpt-5-codex", "gpt-4.1",
];

// ------------------------------------------------------------------
// ProviderSpec — 每个提供者一个对象
// ------------------------------------------------------------------

/** 处理此提供者的具体提供者类（注册表调度，数据驱动） */
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

/** 提供者 API 凭据的来源方式。一个辨别答案，不是一堆可选值。 */
export type CredentialSpec =
  | { kind: "env"; envVar: string }
  | { kind: "managed"; internalEnvVar: string; externalEnvVars: readonly string[] }
  | { kind: "oauth"; flow: "openai-codex" | "copilot"; envVar: string }
  | { kind: "local"; envVar: string };

/**
 * 线轴默认值。具体值固定轴；"by-family" 哨兵
 * 延迟到模型族（Copilot 对 Claude vs GPT 的路由不同），而
 * "openrouter" 固定 OpenRouter Fernet 信封。解析规则是
 * 数据 — 每个模型的结果由 resolveProviderWireAxes 计算。
 */
export interface WireDefaults {
  transportProtocol: TransportProtocol | "by-family";
  thinkingEncryption: ThinkingEncryption | "by-family";
  sealedSchema: SealedSchema | null | "by-family" | "openrouter";
}

/** 提供者公开的模型 — 对 MODEL_SPECS 的引用加上每个条目的覆盖。 */
export interface ProviderModelRef {
  /** 发送到提供者的 API 模型 id；默认 = spec（如 OpenRouter "anthropic/claude-haiku-4.5"） */
  id?: string;
  /** 用于能力/标签的 ModelSpec id；也是默认 API id。仅对无 spec 模型省略。 */
  spec?: string;
  /** picker 选择器；默认 = 有效 id。 */
  key?: string;
  /** 显示标签覆盖；默认 = 引用 spec 的 displayName。 */
  label?: string;
  optionNote?: string;
  aliases?: readonly string[];
  config?: Record<string, unknown>;
}

/** 三级 picker 分组（区域/计划族） */
export interface ProviderGroup {
  id: string;
  label: string;
  subLabel: string;
}

export interface ProviderSpec {
  id: string;
  /** 用于 init / 错误消息的完整名称，如 "Anthropic (Claude)"。 */
  name: string;
  /** 品牌键/标签（BRAND_LABEL_OVERRIDES）。 */
  brand: string;
  /** Picker 提供者节点标签（PROVIDER_LABEL_OVERRIDES）。默认从 name 派生。 */
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

/** 引用的有效 API 模型 id：显式 id，否则引用 spec id。 */
export function providerModelEffectiveId(ref: ProviderModelRef): string {
  return ref.id ?? ref.spec ?? "";
}

/** 引用的有效 picker 选择器键：显式键，否则有效 id。 */
export function providerModelKey(ref: ProviderModelRef): string {
  return ref.key ?? providerModelEffectiveId(ref);
}

/** 凭据从中获取密钥的环境变量（managed → 内部槽）。 */
export function credentialEnvVar(c: CredentialSpec): string {
  switch (c.kind) {
    case "env": return c.envVar;
    case "managed": return c.internalEnvVar;
    case "oauth": return c.envVar;
    case "local": return c.envVar;
  }
}

/**
 * OpenRouter 的供应商前缀 → 我们的品牌标签。不可约简：OpenRouter 名称
 * 与我们不同（moonshotai → Kimi，z-ai → GLM），
 * 该映射无法从其他任何东西派生 — 但它位于此处，集中在
 * 一个地方，而不是分散的。
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
 * 为具体的（提供者-线轴，模型）对解析三个线轴，
 * 展开 "by-family" / "openrouter" 哨兵。精确镜像旧的
 * resolveTransportProtocol / resolveThinkingEncryption / resolveSealedSchema
 * 开关 — 现在由 ProviderSpec.wire 数据驱动。
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
 * 验证原始提供者注册表并返回其 ProviderSpec[]。`knownModelIds`
 * 是所有 ModelSpec id+别名拼写的集合，用于检查每个
 * model.spec 引用是否解析。抛出列出*所有*问题。
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
        // 引用必须解析标签：要么引用已知 spec，要么带有显式标签
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
// 工厂提供者默认值（打包）
// ------------------------------------------------------------------

/** 所有 ModelSpec id+别名拼写 — 用于验证提供者模型引用 */
const FACTORY_MODEL_ID_SET: ReadonlySet<string> = new Set(FACTORY_MODEL_SPECS.flatMap(modelSpecIds));

/** 打包到二进制中的工厂提供者 spec。第 5 阶段在此之上分层远程。 */
export const FACTORY_PROVIDER_SPECS: ProviderSpec[] = loadProviderSpecs(factoryProvidersRaw, FACTORY_MODEL_ID_SET);
