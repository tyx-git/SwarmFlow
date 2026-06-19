/**
 * 远程模型注册表交付 — 获取、验证、缓存（第 6 阶段）。
 *
 * 启动时后台最佳努力刷新从仓库拉取 models.json / providers.json
 * （加上分离的 Ed25519 签名），根据内置公钥验证它们，
 * 通过 loadRemoteRegistry 进行验证 + 版本门控，并且——仅当一切
 * 通过时——将它们写入缓存在下次启动时 registry-effective
 * 读取的缓存（D9 默认：下次启动生成）。任何失败
 *（网络/签名/验证）都是静默的：缓存保持不变，
 * 用户保留最后已知良好的（或工厂的）表。
 *
 * 签名模型：原始 JSON 字节上的纯 Ed25519 分离签名（a
 * `.sig` 文件 = 64 字节签名的 base64）。Felix 生成密钥对
 * 一次使用 scripts/gen-registry-key.ts 并使用
 * scripts/sign-registry.ts 签名发行版；公钥嵌入下方。在真正的密钥
 * 嵌入之前，验证失败关闭 → 远程永远不被信任，使用工厂。
 *（minisign 是最初推荐；纯 Ed25519 保持验证者几行代码，
 * 并避免 minisign 的 BLAKE2b-prehash 格式。）
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { VERSION } from "./version.js";
import { loadRemoteRegistry, remoteCacheDir, type RawRegistryBundle } from "./providers/registry-effective.js";

/**
 * 用于验证远程注册表的内置 Ed25519 公钥（SPKI PEM）。
 * 替换为 `bun run scripts/gen-registry-key.ts` 的输出。为空 =
 * 验证失败关闭（永不信任远程）。
 */
export const REGISTRY_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEApdQv3GlgMKD7y7DDdejGK3sxDMWHCJFvOO/PvaqitKY=\n-----END PUBLIC KEY-----\n";

const DEFAULT_BASE_URL =
  "https://raw.githubusercontent.com/tyx-git/SwarmFlow/main/assets/model-registry";

/** stale-while-revalidate：缓存多久后需要重新获取。 */
export const REGISTRY_REFRESH_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface RegistryCacheMeta {
  fetchedAt: number;
  sourceUrl: string;
  appVersion: string;
}

export type FetchOutcome =
  | { status: "updated"; models: number; providers: number }
  | { status: "skipped"; reason: string }
  | { status: "rejected"; reason: string };

/** 使用 SPKI PEM 密钥验证 `data` 上的分离 Ed25519 签名（base64）。 */
export function verifyDetachedEd25519(data: Uint8Array, sigB64: string, publicKeyPem: string): boolean {
  if (!publicKeyPem || publicKeyPem.trim() === "") return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, data, key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export interface FetchOptions {
  baseUrl?: string;
  homeDir?: string;
  appVersion?: string;
  publicKeyPem?: string;
  /** 整个 fetch 的总超时时间（毫秒）。 */
  timeoutMs?: number;
  now?: number;
}

/**
 * 获取、验证、校验并缓存远程注册表。返回结果；它永不抛出
 *（失败会报告而不传播），因此后台调用方可以忽略结果。
 * 返回 "updated" 时，缓存已为下次启动准备好。
 */
export async function fetchAndCacheRemoteRegistry(opts: FetchOptions = {}): Promise<FetchOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const homeDir = opts.homeDir ?? getSwarmflowHomeDir();
  const appVersion = opts.appVersion ?? VERSION;
  const publicKeyPem = opts.publicKeyPem ?? REGISTRY_PUBLIC_KEY_PEM;
  const now = opts.now ?? Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const [modelsTxt, modelsSig, providersTxt, providersSig] = await Promise.all([
      fetchText(`${baseUrl}/models.json`, controller.signal),
      fetchText(`${baseUrl}/models.json.sig`, controller.signal),
      fetchText(`${baseUrl}/providers.json`, controller.signal),
      fetchText(`${baseUrl}/providers.json.sig`, controller.signal),
    ]);

    const enc = new TextEncoder();
    if (!verifyDetachedEd25519(enc.encode(modelsTxt), modelsSig.trim(), publicKeyPem)) {
      return { status: "rejected", reason: "models.json signature invalid" };
    }
    if (!verifyDetachedEd25519(enc.encode(providersTxt), providersSig.trim(), publicKeyPem)) {
      return { status: "rejected", reason: "providers.json signature invalid" };
    }

    const bundle: RawRegistryBundle = {
      models: JSON.parse(modelsTxt),
      providers: JSON.parse(providersTxt),
    };
    // 缓存前先验证 + 版本门控，确保坏表永远不会被缓存。
    const { models, providers } = loadRemoteRegistry(bundle, appVersion);

    const dir = remoteCacheDir(homeDir);
    mkdirSync(dir, { recursive: true });
    // 缓存经过验证的原始文本（签名覆盖的正是这些字节）以及 meta。
    writeFileSync(join(dir, "models.json"), modelsTxt);
    writeFileSync(join(dir, "providers.json"), providersTxt);
    const meta: RegistryCacheMeta = { fetchedAt: now, sourceUrl: baseUrl, appVersion };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    return { status: "updated", models: models.length, providers: providers.length };
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 如果存在则读取缓存 meta（用于 stale-while-revalidate 决策）。 */
export function readCacheMeta(homeDir: string): RegistryCacheMeta | null {
  try {
    const raw = readFileSync(join(remoteCacheDir(homeDir), "meta.json"), "utf8");
    const meta = JSON.parse(raw) as RegistryCacheMeta;
    return typeof meta.fetchedAt === "number" ? meta : null;
  } catch {
    return null;
  }
}

/** stale-while-revalidate：根据缓存年龄是否应重新获取？ */
export function shouldRefetch(meta: RegistryCacheMeta | null, now: number, ttlMs = REGISTRY_REFRESH_TTL_MS): boolean {
  if (!meta) return true;
  return now - meta.fetchedAt >= ttlMs;
}

/**
 * 启动时即发即忘的后台刷新。遵守 stale-while-revalidate
 *（缓存新鲜则跳过），且永不阻塞或抛出。获取到的表在下次启动生效
 *（会话中不热交换）。
 */
export function startBackgroundRegistryRefresh(opts: FetchOptions = {}): void {
  if (process.env.SWARMFLOW_REGISTRY_NO_REMOTE === "1") return;
  // 尚未嵌入公钥 → 远程永远不能被信任，因此甚至不发起网络请求。
  //（Felix 通过 gen-registry-key.ts 嵌入密钥。）
  if ((opts.publicKeyPem ?? REGISTRY_PUBLIC_KEY_PEM).trim() === "") return;
  const homeDir = opts.homeDir ?? getSwarmflowHomeDir();
  const now = opts.now ?? Date.now();
  if (!shouldRefetch(readCacheMeta(homeDir), now)) return;
  void fetchAndCacheRemoteRegistry(opts).catch(() => { /* 尽力而为 */ });
}
