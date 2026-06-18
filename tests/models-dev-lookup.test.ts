import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetModelsDevCache,
  buildModelsDevIndex,
  fetchModelSpecSuggestion,
} from "../src/models-dev-lookup.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; _resetModelsDevCache(); });

const API = {
  zai: { models: {
    "glm-5.2": {
      limit: { context: 1000000, output: 131072 },
      modalities: { input: ["text"] },
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["high", "max"] }],
    },
  } },
  vendorx: { models: {
    "vendorx/vision-model": {
      limit: { context: 128000, output: 8192 },
      modalities: { input: ["text", "image"] },
      reasoning: false,
    },
    "toggle-model": {
      limit: { context: 64000 },
      modalities: { input: ["text"] },
      reasoning: true,
      reasoning_options: [{ type: "toggle" }],
    },
  } },
};

describe("buildModelsDevIndex", () => {
  it("extracts ctx/output/multimodal/thinking and normalizes ids", () => {
    const idx = buildModelsDevIndex(API);

    const glm = idx.get("glm-5.2");
    expect(glm).toEqual({ contextLength: 1000000, maxOutputTokens: 131072, multimodal: false, thinkingLevels: ["high", "max"] });

    // vendor prefix stripped + image input → multimodal; reasoning false → no thinking
    const vision = idx.get("vision-model");
    expect(vision?.multimodal).toBe(true);
    expect(vision?.contextLength).toBe(128000);
    expect(vision?.thinkingLevels).toBeUndefined();

    // toggle reasoning → off/on
    expect(idx.get("toggle-model")?.thinkingLevels).toEqual(["off", "on"]);
  });

  it("tolerates a malformed catalog", () => {
    expect(buildModelsDevIndex(null).size).toBe(0);
    expect(buildModelsDevIndex({ x: {} }).size).toBe(0);
  });
});

describe("fetchModelSpecSuggestion", () => {
  const home = () => mkdtempSync(join(tmpdir(), "swarmflow-md-"));

  it("fetches + suggests by normalized id, null for unknown", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(API), { status: 200 })) as typeof fetch;
    const h = home();
    expect(await fetchModelSpecSuggestion("glm-5.2", { homeDir: h })).toMatchObject({ contextLength: 1000000 });
    // vendor-prefixed query resolves to same normalized entry
    expect(await fetchModelSpecSuggestion("anything/vision-model", { homeDir: h })).toMatchObject({ multimodal: true });
    expect(await fetchModelSpecSuggestion("totally-unknown-xyz", { homeDir: h })).toBeNull();
  });

  it("returns null (not throw) on network failure", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await fetchModelSpecSuggestion("glm-5.2", { homeDir: home() })).toBeNull();
  });
});
