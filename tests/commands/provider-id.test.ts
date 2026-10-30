import { describe, expect, it } from "vitest";

import { resolveUniqueProviderId, slugifyProviderId } from "../../src/commands/provider/endpoint.js";
import { runtimeModelName } from "../../src/models/selection.js";
import { customProviderEnvVar } from "../../src/providers/credential-flow.js";

describe("provider id derivation", () => {
  it("keeps Chinese names instead of collapsing to custom", () => {
    expect(slugifyProviderId("我的供应商")).toBe("我的供应商");
    expect(slugifyProviderId("我的 中转")).toBe("我的-中转");
    expect(slugifyProviderId("OpenAI 兼容")).toBe("openai-兼容");
  });

  it("keeps the ASCII normalization unchanged", () => {
    expect(slugifyProviderId("  My LLM  ")).toBe("my-llm");
    expect(slugifyProviderId("JuCode")).toBe("jucode");
    expect(slugifyProviderId("a---b")).toBe("a-b");
  });

  it("falls back to custom only when no letter or digit remains", () => {
    expect(slugifyProviderId("!!!")).toBe("custom");
    expect(slugifyProviderId("   ")).toBe("custom");
    expect(slugifyProviderId("中文🙂")).toBe("中文");
  });

  it("suffixes duplicate ids with _2 upward", () => {
    const taken = new Set<string>();
    expect(resolveUniqueProviderId("custom", (id) => taken.has(id))).toBe("custom");
    taken.add("custom");
    expect(resolveUniqueProviderId("custom", (id) => taken.has(id))).toBe("custom_2");
    taken.add("custom_2");
    expect(resolveUniqueProviderId("custom", (id) => taken.has(id))).toBe("custom_3");
  });

  it("suffixes duplicate valid names too", () => {
    expect(resolveUniqueProviderId("我的供应商", (id) => id === "我的供应商")).toBe("我的供应商_2");
  });
});

describe("custom provider env vars", () => {
  it("keeps legacy ASCII names unchanged", () => {
    expect(customProviderEnvVar("my-llm")).toBe("SWARMFLOW_CUSTOM_MY_LLM_KEY");
  });

  it("does not collide for different Chinese provider ids", () => {
    const a = customProviderEnvVar("我的供应商");
    const b = customProviderEnvVar("另一个供应商");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z0-9_]+$/);
    expect(b).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe("runtime model names for Unicode ids", () => {
  it("keeps legacy ASCII names unchanged", () => {
    expect(runtimeModelName("openai-codex", "gpt-5.3-codex")).toBe("runtime-openai-codex-gpt-5-3-codex");
  });

  it("keeps distinct Unicode names distinct and path-safe", () => {
    const a = runtimeModelName("我的供应商", "模型");
    const b = runtimeModelName("另一个供应商", "模型");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});
