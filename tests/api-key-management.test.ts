import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDotenvKey, unsetDotenvKey } from "../src/dotenv.js";
import {
  resolveCredentialSlot,
  customProviderEnvVar,
  isCredentialConfigured,
  setCredentialKey,
  removeCredentialKey,
} from "../src/provider-credential-flow.js";
import { buildCredentialEndpointTree } from "../src/model-picker-tree.js";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

function stashEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "swarmflow-key-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("dotenv unsetDotenvKey", () => {
  test("removes only the target line and the process env value", () => {
    stashEnv("SWARMFLOW_TEST_A", "SWARMFLOW_TEST_B");
    setDotenvKey("SWARMFLOW_TEST_A", "aaa", home);
    setDotenvKey("SWARMFLOW_TEST_B", "bbb", home);
    expect(process.env.SWARMFLOW_TEST_A).toBe("aaa");

    unsetDotenvKey("SWARMFLOW_TEST_A", home);

    expect(process.env.SWARMFLOW_TEST_A).toBeUndefined();
    expect(process.env.SWARMFLOW_TEST_B).toBe("bbb");
    const content = readFileSync(join(home, ".env"), "utf-8");
    expect(content).not.toContain("SWARMFLOW_TEST_A=");
    expect(content).toContain("SWARMFLOW_TEST_B=bbb");
  });

  test("no-op when the file is absent", () => {
    expect(() => unsetDotenvKey("NOPE", home)).not.toThrow();
    expect(existsSync(join(home, ".env"))).toBe(false);
  });
});

describe("resolveCredentialSlot", () => {
  test("env provider → preset env var", () => {
    const slot = resolveCredentialSlot("openai");
    expect(slot?.kind).toBe("env");
    expect(slot?.envVar).toBe("OPENAI_API_KEY");
  });

  test("managed sub-providers each have their own internal var", () => {
    expect(resolveCredentialSlot("kimi")?.envVar).toBe("SWARMFLOW_KIMI_API_KEY");
    expect(resolveCredentialSlot("kimi-cn")?.envVar).toBe("SWARMFLOW_KIMI_CN_API_KEY");
    expect(resolveCredentialSlot("kimi-code")?.envVar).toBe("SWARMFLOW_KIMI_CODE_API_KEY");
    for (const id of ["kimi", "kimi-cn", "kimi-code"]) {
      expect(resolveCredentialSlot(id)?.kind).toBe("managed");
    }
  });

  test("oauth and local providers have no manageable key slot", () => {
    expect(resolveCredentialSlot("openai-codex")).toBeUndefined();
    expect(resolveCredentialSlot("copilot")).toBeUndefined();
    expect(resolveCredentialSlot("ollama")).toBeUndefined();
  });

  test("unknown provider → custom slot with deterministic env var", () => {
    const slot = resolveCredentialSlot("my-llm", { label: "My LLM" });
    expect(slot?.kind).toBe("custom");
    expect(slot?.envVar).toBe(customProviderEnvVar("my-llm"));
    expect(slot?.envVar).toBe("SWARMFLOW_CUSTOM_MY_LLM_KEY");
    expect(slot?.label).toBe("My LLM");
  });
});

describe("set/remove credential key", () => {
  test("env slot round-trips and reports shell-resurface on removal", () => {
    stashEnv("OPENAI_API_KEY");
    delete process.env.OPENAI_API_KEY;
    const slot = resolveCredentialSlot("openai")!;
    expect(isCredentialConfigured(slot)).toBe(false);

    setCredentialKey(slot, "sk-test-1234", home);
    expect(isCredentialConfigured(slot)).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-1234");

    const result = removeCredentialKey(slot, home);
    expect(result.shellMayResurface).toBe(true); // env kind
    expect(isCredentialConfigured(slot)).toBe(false);
  });

  test("managed removal is definitive (no shell resurface)", () => {
    stashEnv("SWARMFLOW_KIMI_API_KEY");
    delete process.env.SWARMFLOW_KIMI_API_KEY;
    const slot = resolveCredentialSlot("kimi")!;
    setCredentialKey(slot, "kimi-key", home);
    expect(isCredentialConfigured(slot)).toBe(true);
    const result = removeCredentialKey(slot, home);
    expect(result.shellMayResurface).toBe(false);
  });
});

describe("buildCredentialEndpointTree", () => {
  const session = { config: undefined };

  test("keyed registry endpoints only by default; oauth/local excluded", () => {
    const tree = buildCredentialEndpointTree({ session });
    const ids = new Set(tree.map((n) => n.id));
    // env providers present
    expect(ids.has("openai")).toBe(true);
    expect(ids.has("anthropic")).toBe(true);
    // oauth / local excluded
    expect(ids.has("openai-codex")).toBe(false);
    expect(ids.has("copilot")).toBe(false);
    expect(ids.has("ollama")).toBe(false);
  });

  test("group providers descend to each sub-provider endpoint", () => {
    const tree = buildCredentialEndpointTree({ session });
    const kimiGroup = tree.find((n) => n.id === "kimi" && n.kind === "group");
    expect(kimiGroup).toBeDefined();
    const childIds = new Set((kimiGroup!.children ?? []).map((c) => c.id));
    expect(childIds.has("kimi")).toBe(true);
    expect(childIds.has("kimi-cn")).toBe(true);
    expect(childIds.has("kimi-code")).toBe(true);
  });

  test("includeOAuthAndLocal adds oauth + local leaves", () => {
    const tree = buildCredentialEndpointTree({ session }, { includeOAuthAndLocal: true });
    const ids = new Set(tree.map((n) => n.id));
    expect(ids.has("openai-codex")).toBe(true);
    expect(ids.has("ollama")).toBe(true);
  });
});
