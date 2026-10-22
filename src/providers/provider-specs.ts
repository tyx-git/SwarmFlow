/**
 * 提供者连接元数据的静态数据来源。
 *
 * *schema* 和 *validator* 位于此处（代码，随版本发布）。
 * 用户模型列表位于 settings.json；此注册表只包含认证、默认 URL、
 * provider 实现类型和协议默认值。
 */

import factoryProvidersRaw from "../../assets/model-registry/providers.json" with { type: "json" };
import {
  type SealedSchema,
  type ThinkingEncryption,
  type TransportProtocol,
  SEALED_SCHEMA_ANTHROPIC_MESSAGES,
  SEALED_SCHEMA_OPENAI_RESPONSES,
  SEALED_SCHEMA_OPENROUTER_CHAT,
  isAnthropicFamilyModel,
  isOpenAIFamilyModel,
} from "../thinking/artifact.js";

export const PROVIDER_REGISTRY_SCHEMA_VERSION = 1;

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
}

export interface RawProviderRegistry {
  schemaVersion: number;
  providers: ProviderSpec[];
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
 * 验证原始提供者注册表并返回其 ProviderSpec[]。
 */
export function loadProviderSpecs(raw: unknown): ProviderSpec[] {
  const problems: string[] = [];
  const reg = raw as RawProviderRegistry;

  if (!reg || typeof reg !== "object" || !Array.isArray(reg.providers)) {
    throw new Error("provider registry: expected { schemaVersion, providers: [...] }");
  }
  if (reg.schemaVersion !== PROVIDER_REGISTRY_SCHEMA_VERSION) {
    problems.push(`schemaVersion ${reg.schemaVersion} != expected ${PROVIDER_REGISTRY_SCHEMA_VERSION}`);
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
  }

  if (problems.length > 0) {
    throw new Error(`provider registry invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return reg.providers;
}

// ------------------------------------------------------------------
// 工厂提供者默认值（打包）
// ------------------------------------------------------------------

/** 打包的连接元数据；模型目录由用户配置或官方登录发现提供。 */
export const FACTORY_PROVIDER_SPECS: ProviderSpec[] = loadProviderSpecs(factoryProvidersRaw);
