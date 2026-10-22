import { describe, expect, it } from "vitest";

import { Config } from "../../src/config/loader.js";
import { buildModelPickerTree } from "../../src/models/picker/model-tree.js";
import type { ModelPickerTreeNode } from "../../src/models/picker/types.js";

/**
 * 选择器的「当前模型」标记（`isCurrent`）有三条独立命中路径，
 * 期望值按行为规格硬编码，不调用被测实现来计算。
 */

const PROVIDER = "openai";
const ACTIVE_MODEL = "gpt-5.4";
const OTHER_MODEL = "gpt-5-mini";

function makeConfig(): Config {
  const config = new Config({});
  config.upsertModelRaw(`${PROVIDER}:${ACTIVE_MODEL}`, {
    provider: PROVIDER,
    model: ACTIVE_MODEL,
    api_key: "sk-test-active",
  });
  config.upsertModelRaw(`${PROVIDER}:${OTHER_MODEL}`, {
    provider: PROVIDER,
    model: OTHER_MODEL,
    api_key: "sk-test-other",
  });
  return config;
}

function makeSessionView(opts: {
  currentModelConfigName?: string;
  active?: { provider: string; model: string };
  config?: Config;
}) {
  return {
    config: opts.config ?? makeConfig(),
    currentModelConfigName: opts.currentModelConfigName ?? "",
    primaryAgent: {
      modelConfig: opts.active ?? { provider: "", model: "" },
    },
  };
}

function collectModelLeaves(nodes: ModelPickerTreeNode[]): ModelPickerTreeNode[] {
  const out: ModelPickerTreeNode[] = [];
  const walk = (list: ModelPickerTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "model") out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function currentLeafValues(nodes: ModelPickerTreeNode[]): string[] {
  return collectModelLeaves(nodes)
    .filter((leaf) => leaf.isCurrent === true)
    .map((leaf) => leaf.value);
}

describe("model picker current marker", () => {
  it("marks the leaf whose provider:model name equals the session config name", () => {
    const nodes = buildModelPickerTree({
      session: makeSessionView({ currentModelConfigName: `${PROVIDER}:${ACTIVE_MODEL}` }),
    });

    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${ACTIVE_MODEL}`]);
  });

  it("marks the leaf whose runtime config name matches a provider:model target", () => {
    // `openai` + `gpt-5.4` 经临时解析后的配置名；与 `openai:gpt-5.4` 不同形，
    // 走的是 isCurrentSelection 的第二条判定。
    const nodes = buildModelPickerTree({
      session: makeSessionView({ currentModelConfigName: "runtime-openai-gpt-5-4" }),
    });

    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${ACTIVE_MODEL}`]);
  });

  it("marks the leaf the primary agent is actually running when no config name matches", () => {
    const nodes = buildModelPickerTree({
      session: makeSessionView({
        currentModelConfigName: "",
        active: { provider: PROVIDER, model: ACTIVE_MODEL },
      }),
    });

    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${ACTIVE_MODEL}`]);
  });

  it("marks nothing when neither name nor the running agent matches", () => {
    const nodes = buildModelPickerTree({
      session: makeSessionView({
        currentModelConfigName: "anthropic:claude-opus",
        active: { provider: "anthropic", model: "claude-opus" },
      }),
    });

    expect(currentLeafValues(nodes)).toEqual([]);
  });

  it("marks only the running leaf, not its provider's sibling models", () => {
    const nodes = buildModelPickerTree({
      session: makeSessionView({
        currentModelConfigName: "",
        active: { provider: PROVIDER, model: OTHER_MODEL },
      }),
    });

    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${OTHER_MODEL}`]);
  });

  it("marks only the running leaf when two providers expose the same model id", () => {
    const shared = "shared-reasoner";
    const config = new Config({});
    config.upsertModelRaw(`${PROVIDER}:${shared}`, {
      provider: PROVIDER,
      model: shared,
      api_key: "sk-test-a",
    });
    config.upsertModelRaw(`anthropic:${shared}`, {
      provider: "anthropic",
      model: shared,
      api_key: "sk-test-b",
    });

    const nodes = buildModelPickerTree({
      session: makeSessionView({
        config,
        currentModelConfigName: "",
        active: { provider: PROVIDER, model: shared },
      }),
    });

    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${shared}`]);
  });

  it("marks at most one leaf for the active model even when several paths match at once", () => {
    const nodes = buildModelPickerTree({
      session: makeSessionView({
        currentModelConfigName: `${PROVIDER}:${ACTIVE_MODEL}`,
        active: { provider: PROVIDER, model: ACTIVE_MODEL },
      }),
      currentSelection: {
        configName: `${PROVIDER}:${ACTIVE_MODEL}`,
        provider: PROVIDER,
        selectionKey: ACTIVE_MODEL,
        modelId: ACTIVE_MODEL,
      },
    });

    const leaves = collectModelLeaves(nodes);
    expect(leaves.length).toBe(2);
    expect(currentLeafValues(nodes)).toEqual([`${PROVIDER}:${ACTIVE_MODEL}`]);
  });
});
