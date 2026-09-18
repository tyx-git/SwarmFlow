/**
 * 有效的模型/提供者注册表 = 工厂默认值或经过验证的版本
 * 门控远程覆盖（整数表替换 — 表是整体选择的，
 * 从不合并；D8）。在模块加载时同步选择，因此每个消费者
 * 从有效表派生，没有会话中期交换（D9：默认是
 * 下次启动生成）。
 *
 * 第 5 阶段仅加载本地缓存的远程包（如果存在且有效）；
 * 网络获取 + 签名验证填充该缓存位于
 * 第 6 阶段。任何问题（缺失/损坏/无效/版本过高）都回退到
 * 工厂，因此用户永远不会没有可用的模型列表。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { VERSION } from "../version.js";
import {
  FACTORY_MODEL_SPECS,
  FACTORY_PROVIDER_SPECS,
  type DerivedModelTables,
  type ModelSpec,
  type ProviderSpec,
  deriveModelTables,
  loadModelSpecs,
  loadProviderSpecs,
  modelSpecIds,
} from "../models/registry.js";

// ------------------------------------------------------------------
// 最小 semver 比较 — 仅用于门控（数字 major.minor.patch；
// 忽略任何预发布后缀，即预发布版本按其基础版本计算）。
// ------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isVersionAtLeast(version: string, min: string): boolean {
  return compareVersions(version, min) >= 0;
}

// ------------------------------------------------------------------
// 远程包 → 已验证且经过版本门控的 specs
// ------------------------------------------------------------------

export interface RawRegistryBundle {
  models: unknown;
  providers: unknown;
}

export interface EffectiveRegistry {
  models: ModelSpec[];
  providers: ProviderSpec[];
  source: "factory" | "remote";
}

/**
 * 验证远程包并执行版本门控。结构无效时抛出，调用方即可回退到 factory
 *（整表替换）。minAppVersion 超过 appVersion 的模型/提供者条目会被丢弃 —
 * 一张发布表可以同时服务新旧 app 版本，各自采用可运行的部分。
 */
export function loadRemoteRegistry(
  bundle: RawRegistryBundle,
  appVersion: string,
): { models: ModelSpec[]; providers: ProviderSpec[] } {
  const allModels = loadModelSpecs(bundle.models);
  const models = allModels.filter(
    (s) => !s.minAppVersion || isVersionAtLeast(appVersion, s.minAppVersion),
  );
  const allModelIds = new Set(allModels.flatMap(modelSpecIds));
  const gatedModelIds = new Set(models.flatMap(modelSpecIds));

  // 验证前先按提供者自身 minAppVersion 预过滤，因此未来提供者
  //（例如带有当前版本代码不认识的 providerClass）会在旧 app 上被丢弃，
  // 而不是拖垮整张表。
  const providersObj = bundle.providers as { schemaVersion?: number; providers?: unknown[] };
  const rawProviders = providersObj?.providers;
  if (!Array.isArray(rawProviders)) {
    throw new Error("provider registry: expected { schemaVersion, providers: [...] }");
  }
  const gatedRawProviders = rawProviders.filter((p) => {
    const min = (p as { minAppVersion?: string })?.minAppVersion;
    return !min || isVersionAtLeast(appVersion, min);
  });

  // 针对所有模型（未门控）验证引用，因此真正缺失的 spec 仍会报错，
  // 但指向被版本门控排除模型的引用会在之后被丢弃。
  const providers = loadProviderSpecs(
    { schemaVersion: providersObj.schemaVersion ?? 0, providers: gatedRawProviders },
    allModelIds,
  ).map((p) => ({
    ...p,
    models: p.models.filter((ref) => ref.spec === undefined || gatedModelIds.has(ref.spec)),
  }));

  return { models, providers };
}

// ------------------------------------------------------------------
// 缓存 I/O + 有效选择
// ------------------------------------------------------------------

/** 存放远程注册表缓存的目录（由第 6 阶段获取填充）。 */
export function remoteCacheDir(homeDir: string): string {
  return join(homeDir, "model-registry", "cache");
}

function tryReadCachedRemoteSync(homeDir: string): RawRegistryBundle | null {
  const dir = remoteCacheDir(homeDir);
  const mPath = join(dir, "models.json");
  const pPath = join(dir, "providers.json");
  if (!existsSync(mPath) || !existsSync(pPath)) return null;
  try {
    return {
      models: JSON.parse(readFileSync(mPath, "utf8")),
      providers: JSON.parse(readFileSync(pPath, "utf8")),
    };
  } catch {
    return null;
  }
}

/**
 * 选择有效注册表：如果存在有效且经过版本门控的缓存远程包，则使用它；
 * 否则使用打包的 factory 默认值。`SWARMFLOW_REGISTRY_NO_REMOTE=1`
 * 强制使用 factory（用于保持测试/调试确定性）。
 */
export function selectEffectiveRegistry(homeDir: string, appVersion: string): EffectiveRegistry {
  if (process.env.SWARMFLOW_REGISTRY_NO_REMOTE !== "1") {
    const cached = tryReadCachedRemoteSync(homeDir);
    if (cached) {
      try {
        const { models, providers } = loadRemoteRegistry(cached, appVersion);
        return { models, providers, source: "remote" };
      } catch {
        // 损坏 / 无效 / 版本过高的缓存 → 回退到 factory。
      }
    }
  }
  return { models: FACTORY_MODEL_SPECS, providers: FACTORY_PROVIDER_SPECS, source: "factory" };
}

const _effective = selectEffectiveRegistry(getSwarmflowHomeDir(), VERSION);

/** 此进程中实际有效的模型 specs（factory → remote）。*/
export const EFFECTIVE_MODEL_SPECS: ModelSpec[] = _effective.models;
/** 此进程中实际有效的提供者 specs（factory → remote）。*/
export const EFFECTIVE_PROVIDER_SPECS: ProviderSpec[] = _effective.providers;
/** 有效模型 specs 派生出的能力表。 */
export const EFFECTIVE_MODEL_TABLES: DerivedModelTables = deriveModelTables(_effective.models);
/** 有效注册表来自打包默认值还是远程覆盖。 */
export const EFFECTIVE_REGISTRY_SOURCE: "factory" | "remote" = _effective.source;
