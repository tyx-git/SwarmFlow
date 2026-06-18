/**
 * Effective model/provider registry = factory defaults OR a validated, version-
 * gated remote override (integer table replacement 鈥?the table is chosen whole,
 * never merged; D8). Selected synchronously at module load so every consumer
 * derives from the effective tables with no mid-session swap (D9: default is
 * next-startup generation).
 *
 * Phase 5 only LOADS a locally-cached remote bundle if present and valid; the
 * network fetch + signature verification that POPULATE that cache live in
 * Phase 6. Any problem (missing/corrupt/invalid/over-version) falls back to
 * factory, so the user is never left without a usable model list.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { VERSION } from "./version.js";
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
} from "./models/registry.js";

// ------------------------------------------------------------------
// Minimal semver compare 鈥?gating only (numeric major.minor.patch; any
// prerelease suffix is ignored, i.e. a prerelease counts as its base version).
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
// Remote bundle 鈫?validated, version-gated specs
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
 * Validate + version-gate a remote bundle. Throws on structural invalidity so
 * the caller can fall back to factory (whole-table replacement). Model/provider
 * entries whose minAppVersion exceeds appVersion are dropped 鈥?one published
 * table can serve both new and old app versions, each taking what it can run.
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

  // Pre-filter providers by their OWN minAppVersion before validation, so a
  // future provider (e.g. with a providerClass this version's code doesn't know)
  // is dropped rather than sinking the whole table on an older app.
  const providersObj = bundle.providers as { schemaVersion?: number; providers?: unknown[] };
  const rawProviders = providersObj?.providers;
  if (!Array.isArray(rawProviders)) {
    throw new Error("provider registry: expected { schemaVersion, providers: [...] }");
  }
  const gatedRawProviders = rawProviders.filter((p) => {
    const min = (p as { minAppVersion?: string })?.minAppVersion;
    return !min || isVersionAtLeast(appVersion, min);
  });

  // Validate refs against ALL models (ungated) so a genuinely-missing spec still
  // errors, but a ref to a version-gated-out model is dropped afterward.
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
// Cache I/O + effective selection
// ------------------------------------------------------------------

/** Directory holding the cached remote registry (populated by Phase 6 fetch). */
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
 * Pick the effective registry: a valid, version-gated cached remote bundle if
 * one is present, else the bundled factory defaults. `SWARMFLOW_REGISTRY_NO_REMOTE=1`
 * forces factory (used to keep tests / debugging deterministic).
 */
export function selectEffectiveRegistry(homeDir: string, appVersion: string): EffectiveRegistry {
  if (process.env.SWARMFLOW_REGISTRY_NO_REMOTE !== "1") {
    const cached = tryReadCachedRemoteSync(homeDir);
    if (cached) {
      try {
        const { models, providers } = loadRemoteRegistry(cached, appVersion);
        return { models, providers, source: "remote" };
      } catch {
        // Corrupt / invalid / over-version cache 鈫?fall through to factory.
      }
    }
  }
  return { models: FACTORY_MODEL_SPECS, providers: FACTORY_PROVIDER_SPECS, source: "factory" };
}

const _effective = selectEffectiveRegistry(getSwarmflowHomeDir(), VERSION);

/** The model specs actually in effect this process (factory 鈭?remote). */
export const EFFECTIVE_MODEL_SPECS: ModelSpec[] = _effective.models;
/** The provider specs actually in effect this process (factory 鈭?remote). */
export const EFFECTIVE_PROVIDER_SPECS: ProviderSpec[] = _effective.providers;
/** Derived capability tables for the effective model specs. */
export const EFFECTIVE_MODEL_TABLES: DerivedModelTables = deriveModelTables(_effective.models);
/** Whether the effective registry came from the bundled defaults or a remote override. */
export const EFFECTIVE_REGISTRY_SOURCE: "factory" | "remote" = _effective.source;
