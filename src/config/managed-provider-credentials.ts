/**
 * 受管云 Provider 凭证槽位。
 *
 * 这些 Provider 始终从 swarmflow 受管环境变量解析凭证。
 * 外部 shell 环境变量仅在初始化时作为导入候选。
 */

import { EFFECTIVE_PROVIDER_SPECS } from "./providers/registry-effective.js";

/** 受管凭证的元数据：内部变量名 + 外部候选变量列表。 */
export interface ManagedProviderCredentialSpec {
  providerId: string;
  internalEnvVar: string;
  externalEnvVars: string[];
}

/** 从 provider specs 派生（单一数据源：providers.json）。 */
export const MANAGED_PROVIDER_CREDENTIAL_SPECS: ManagedProviderCredentialSpec[] =
  EFFECTIVE_PROVIDER_SPECS.flatMap((spec) =>
    spec.credential.kind === "managed"
      ? [{
          providerId: spec.id,
          internalEnvVar: spec.credential.internalEnvVar,
          externalEnvVars: [...spec.credential.externalEnvVars],
        }]
      : [],
  );

const SPEC_BY_PROVIDER = new Map(
  MANAGED_PROVIDER_CREDENTIAL_SPECS.map((spec) => [spec.providerId, spec] as const),
);

/** Provider 凭证种类（从注册表派生，单一数据源）。 */
export type ProviderCredentialKind = "env" | "managed" | "oauth" | "local";

const CREDENTIAL_KIND_BY_PROVIDER = new Map<string, ProviderCredentialKind>(
  EFFECTIVE_PROVIDER_SPECS.map((spec) => [spec.id, spec.credential.kind] as const),
);

/**
 * 返回注册表 provider 的凭证种类；对于不在注册表中的 provider
 *（如用户自定义 provider）返回 undefined。
 */
export function providerCredentialKind(
  providerId: string,
): ProviderCredentialKind | undefined {
  return CREDENTIAL_KIND_BY_PROVIDER.get(providerId);
}

export interface DetectedCredentialCandidate {
  envVar: string;
  value: string;
}

/** 判断 provider 是否为受管 Provider。 */
export function isManagedProvider(providerId: string): boolean {
  return SPEC_BY_PROVIDER.has(providerId);
}

/** 获取 provider 的受管凭证规格。 */
export function getManagedCredentialSpec(
  providerId: string,
): ManagedProviderCredentialSpec | undefined {
  return SPEC_BY_PROVIDER.get(providerId);
}

/** 获取 provider 内部受管环境变量名。 */
export function getManagedCredentialEnvVar(
  providerId: string,
): string | undefined {
  return SPEC_BY_PROVIDER.get(providerId)?.internalEnvVar;
}

/** 检查 provider 是否已有非空受管凭证（从 process.env 或指定 env 查找）。 */
export function hasManagedCredential(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envVar = getManagedCredentialEnvVar(providerId);
  const raw = envVar ? env[envVar] : undefined;
  return typeof raw === "string" && raw.trim() !== "";
}

/** 检测外部 shell 中可导入的候选凭证（如用户已设置 ANTHROPIC_API_KEY）。 */
export function detectManagedCredentialCandidates(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): DetectedCredentialCandidate[] {
  const spec = getManagedCredentialSpec(providerId);
  if (!spec) return [];

  const out: DetectedCredentialCandidate[] = [];
  const seen = new Set<string>();
  for (const envVar of spec.externalEnvVars) {
    if (seen.has(envVar)) continue;
    seen.add(envVar);
    const raw = env[envVar];
    if (typeof raw === "string" && raw.trim() !== "") {
      out.push({ envVar, value: raw });
    }
  }
  return out;
}

/** 检查是否存在任何 provider 的非空受管凭证。 */
export function hasAnyManagedCredential(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return MANAGED_PROVIDER_CREDENTIAL_SPECS.some((spec) => {
    const raw = env[spec.internalEnvVar];
    return typeof raw === "string" && raw.trim() !== "";
  });
}
