import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Config } from "../src/config.js";
import { detectManagedCredentialCandidates } from "../src/managed-provider-credentials.js";

const ENV_VARS = [
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "SWARMFLOW_QWEN_API_KEY",
  "SWARMFLOW_QWEN_INTL_API_KEY",
  "SWARMFLOW_QWEN_US_API_KEY",
  "SWARMFLOW_GLM_API_KEY",
  "SWARMFLOW_GLM_INTL_API_KEY",
  "SWARMFLOW_GLM_CODE_API_KEY",
  "SWARMFLOW_GLM_INTL_CODE_API_KEY",
  "SWARMFLOW_KIMI_API_KEY",
  "SWARMFLOW_KIMI_CN_API_KEY",
  "SWARMFLOW_KIMI_CODE_API_KEY",
  "SWARMFLOW_MINIMAX_API_KEY",
  "SWARMFLOW_MINIMAX_CN_API_KEY",
];

const savedEnv = new Map<string, string | undefined>();

describe("managed provider credentials", () => {
  beforeEach(() => {
    savedEnv.clear();
    for (const envVar of ENV_VARS) {
      savedEnv.set(envVar, process.env[envVar]);
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const [envVar, value] of savedEnv.entries()) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    savedEnv.clear();
  });

  it("auto-registers managed provider models from SwarmFlow env slots", () => {
    process.env["SWARMFLOW_GLM_CODE_API_KEY"] = "glm-code-secret";

    const cfg = new Config({});

    expect(cfg.modelNames).toContain("glm-code:glm-5");
    expect(cfg.modelNames).toContain("glm-code:glm-4.7");
    expect(cfg.getModel("glm-code:glm-5").apiKey).toBe("glm-code-secret");
  });

  it("does not share managed credentials across endpoints", () => {
    process.env["SWARMFLOW_GLM_API_KEY"] = "glm-standard-secret";

    const cfg = new Config({});

    expect(cfg.modelNames).toContain("glm:glm-5");
    expect(cfg.modelNames).not.toContain("glm-code:glm-5");
  });

  it("keeps Qwen regional credentials scoped to the configured endpoint", () => {
    process.env["SWARMFLOW_QWEN_US_API_KEY"] = "qwen-us-secret";

    const cfg = new Config({});

    expect(cfg.modelNames).toContain("qwen-us:qwen3.6-plus");
    expect(cfg.modelNames).toContain("qwen-us:qwen3.7-max");
    expect(cfg.modelNames).not.toContain("qwen:qwen3.6-plus");
    expect(cfg.modelNames).not.toContain("qwen-intl:qwen3.6-plus");
    expect(cfg.getModel("qwen-us:qwen3.6-plus").apiKey).toBe("qwen-us-secret");
  });

  it("treats external Qwen keys as import candidates, not runtime credentials", () => {
    process.env["DASHSCOPE_API_KEY"] = "qwen-external-secret";

    expect(detectManagedCredentialCandidates("qwen")).toEqual([
      { envVar: "DASHSCOPE_API_KEY", value: "qwen-external-secret" },
    ]);

    const cfg = new Config({});

    expect(cfg.modelNames).not.toContain("qwen:qwen3.6-plus");
    expect(cfg.modelNames).not.toContain("qwen:qwen3.7-max");
  });
});
