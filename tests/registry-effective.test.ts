import { describe, expect, it } from "vitest";

import {
  compareVersions,
  isVersionAtLeast,
  loadRemoteRegistry,
  selectEffectiveRegistry,
  type RawRegistryBundle,
} from "../src/providers/registry-effective.js";

const model = (over: Record<string, unknown>) => ({
  displayName: "X",
  contextLength: 1000,
  multimodal: false,
  thinkingLevels: [],
  webSearch: true,
  ...over,
});

const provider = (over: Record<string, unknown>) => ({
  name: "P",
  brand: "P",
  credential: { kind: "env", envVar: "X" },
  wire: { transportProtocol: "anthropic", thinkingEncryption: "anthropic", sealedSchema: "anthropic-messages" },
  providerClass: "anthropic",
  models: [],
  ...over,
});

describe("semver gating compare", () => {
  it("orders numeric major.minor.patch and ignores prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("0.3.2", "0.3.10")).toBe(-1); // numeric, not lexical
    expect(isVersionAtLeast("0.3.2-alpha.3", "0.3.0")).toBe(true); // prerelease ignored
    expect(isVersionAtLeast("0.3.0", "0.4.0")).toBe(false);
  });
});

describe("loadRemoteRegistry — validation + version gating", () => {
  it("drops models above app version and prunes provider refs to them", () => {
    const bundle: RawRegistryBundle = {
      models: { schemaVersion: 1, models: [
        model({ id: "now-model" }),
        model({ id: "future-model", minAppVersion: "99.0.0" }),
      ] },
      providers: { schemaVersion: 1, providers: [
        provider({ id: "p1", models: [{ spec: "now-model" }, { spec: "future-model" }] }),
      ] },
    };
    const { models, providers } = loadRemoteRegistry(bundle, "1.0.0");
    expect(models.map((m) => m.id)).toEqual(["now-model"]);
    // ref to the gated-out future-model is pruned, not an error
    expect(providers[0]!.models.map((r) => r.spec)).toEqual(["now-model"]);
  });

  it("drops a future provider (unknown providerClass) before it can sink the table", () => {
    const bundle: RawRegistryBundle = {
      models: { schemaVersion: 1, models: [model({ id: "m" })] },
      providers: { schemaVersion: 1, providers: [
        provider({ id: "future-p", minAppVersion: "99.0.0", providerClass: "brand-new-class", models: [] }),
        provider({ id: "p1", models: [{ spec: "m" }] }),
      ] },
    };
    const { providers } = loadRemoteRegistry(bundle, "1.0.0");
    expect(providers.map((p) => p.id)).toEqual(["p1"]); // future-p dropped, no throw
  });

  it("throws on a structurally invalid bundle (caller falls back to factory)", () => {
    const bundle: RawRegistryBundle = {
      models: { schemaVersion: 1, models: [{ id: "bad" }] }, // missing required fields
      providers: { schemaVersion: 1, providers: [] },
    };
    expect(() => loadRemoteRegistry(bundle, "1.0.0")).toThrow();
  });

  it("throws when a provider ref points at a genuinely missing spec", () => {
    const bundle: RawRegistryBundle = {
      models: { schemaVersion: 1, models: [model({ id: "m" })] },
      providers: { schemaVersion: 1, providers: [
        provider({ id: "p1", models: [{ spec: "does-not-exist" }] }),
      ] },
    };
    expect(() => loadRemoteRegistry(bundle, "1.0.0")).toThrow();
  });
});

describe("selectEffectiveRegistry", () => {
  it("falls back to factory when forced or when no cache exists", () => {
    const prev = process.env.SWARMFLOW_REGISTRY_NO_REMOTE;
    process.env.SWARMFLOW_REGISTRY_NO_REMOTE = "1";
    try {
      const eff = selectEffectiveRegistry("/nonexistent-home-dir", "1.0.0");
      expect(eff.source).toBe("factory");
      expect(eff.models.length).toBeGreaterThan(0);
      expect(eff.providers.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.SWARMFLOW_REGISTRY_NO_REMOTE;
      else process.env.SWARMFLOW_REGISTRY_NO_REMOTE = prev;
    }
  });
});
