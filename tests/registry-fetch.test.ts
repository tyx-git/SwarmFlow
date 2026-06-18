import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchAndCacheRemoteRegistry,
  readCacheMeta,
  shouldRefetch,
  verifyDetachedEd25519,
} from "../src/registry-fetch.js";
import { selectEffectiveRegistry } from "../src/registry-effective.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }) as string;
const sig = (text: string) => cryptoSign(null, Buffer.from(text), privateKey).toString("base64");

const MODELS = JSON.stringify({
  schemaVersion: 1,
  models: [{ id: "m", displayName: "M", contextLength: 1000, multimodal: false, thinkingLevels: [], webSearch: true }],
});
const PROVIDERS = JSON.stringify({
  schemaVersion: 1,
  providers: [{
    id: "p", name: "P", brand: "P",
    credential: { kind: "env", envVar: "X" },
    providerClass: "anthropic",
    wire: { transportProtocol: "anthropic", thinkingEncryption: "anthropic", sealedSchema: "anthropic-messages" },
    models: [{ spec: "m" }],
  }],
});

const BASE = "https://example.test/registry";
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function mockFetch(files: Record<string, string>): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    return u in files ? new Response(files[u], { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "swarmflow-reg-"));
}

describe("verifyDetachedEd25519", () => {
  it("accepts a valid signature, rejects tampering and an empty key", () => {
    const data = new TextEncoder().encode("hello");
    expect(verifyDetachedEd25519(data, sig("hello"), PUB)).toBe(true);
    expect(verifyDetachedEd25519(new TextEncoder().encode("hellp"), sig("hello"), PUB)).toBe(false);
    expect(verifyDetachedEd25519(data, sig("hello"), "")).toBe(false);
  });
});

describe("shouldRefetch (stale-while-revalidate)", () => {
  it("refetches when no meta or past TTL, not while fresh", () => {
    expect(shouldRefetch(null, 1000)).toBe(true);
    const meta = { fetchedAt: 1000, sourceUrl: BASE, appVersion: "1.0.0" };
    expect(shouldRefetch(meta, 1050, 100)).toBe(false);
    expect(shouldRefetch(meta, 1100, 100)).toBe(true);
  });
});

describe("fetchAndCacheRemoteRegistry", () => {
  it("fetches, verifies, validates, caches — then select reads it as remote", async () => {
    mockFetch({
      [`${BASE}/models.json`]: MODELS,
      [`${BASE}/models.json.sig`]: sig(MODELS),
      [`${BASE}/providers.json`]: PROVIDERS,
      [`${BASE}/providers.json.sig`]: sig(PROVIDERS),
    });
    const home = freshHome();
    const out = await fetchAndCacheRemoteRegistry({ baseUrl: BASE, homeDir: home, appVersion: "1.0.0", publicKeyPem: PUB, now: 1000 });
    expect(out).toEqual({ status: "updated", models: 1, providers: 1 });
    expect(existsSync(join(home, "model-registry", "cache", "models.json"))).toBe(true);
    expect(readCacheMeta(home)?.fetchedAt).toBe(1000);

    // End-to-end: the cache select reads becomes the remote effective registry.
    const eff = selectEffectiveRegistry(home, "1.0.0");
    expect(eff.source).toBe("remote");
    expect(eff.models.map((m) => m.id)).toEqual(["m"]);
    expect(eff.providers.map((p) => p.id)).toEqual(["p"]);
  });

  it("rejects on a bad signature and writes no cache", async () => {
    mockFetch({
      [`${BASE}/models.json`]: MODELS,
      [`${BASE}/models.json.sig`]: sig("WRONG"),
      [`${BASE}/providers.json`]: PROVIDERS,
      [`${BASE}/providers.json.sig`]: sig(PROVIDERS),
    });
    const home = freshHome();
    const out = await fetchAndCacheRemoteRegistry({ baseUrl: BASE, homeDir: home, appVersion: "1.0.0", publicKeyPem: PUB });
    expect(out.status).toBe("rejected");
    expect(existsSync(join(home, "model-registry", "cache", "models.json"))).toBe(false);
    // select falls back to factory
    expect(selectEffectiveRegistry(home, "1.0.0").source).toBe("factory");
  });

  it("skips on network failure (offline) leaving cache untouched", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const home = freshHome();
    const out = await fetchAndCacheRemoteRegistry({ baseUrl: BASE, homeDir: home, publicKeyPem: PUB });
    expect(out.status).toBe("skipped");
    expect(existsSync(join(home, "model-registry", "cache", "models.json"))).toBe(false);
  });

  it("rejects a structurally invalid (but correctly signed) table", async () => {
    const badModels = JSON.stringify({ schemaVersion: 1, models: [{ id: "x" }] });
    mockFetch({
      [`${BASE}/models.json`]: badModels,
      [`${BASE}/models.json.sig`]: sig(badModels),
      [`${BASE}/providers.json`]: PROVIDERS,
      [`${BASE}/providers.json.sig`]: sig(PROVIDERS),
    });
    const home = freshHome();
    const out = await fetchAndCacheRemoteRegistry({ baseUrl: BASE, homeDir: home, appVersion: "1.0.0", publicKeyPem: PUB });
    expect(out.status).toBe("skipped"); // loadRemoteRegistry throws -> caught -> skipped
    expect(existsSync(join(home, "model-registry", "cache", "models.json"))).toBe(false);
  });
});
