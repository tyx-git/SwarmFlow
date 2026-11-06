/**
 * /provider 选择器选项的结构契约：常用供应商按品牌家族分节、节内用注册表短名、
 * 状态灯来自与 /model 同源的凭据判定，且提交值仍是裸 provider id。
 *
 * 环境变量在断言前清空，保证 tone 只由本用例决定的输入推出。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROVIDER_PRESETS } from "../../src/providers/presets.js";
import { providerOptions } from "../../src/commands/provider/options.js";
import type { CommandOption, CommandOptionsContext } from "../../src/commands/types.js";

const HOME = mkdtempSync(path.join(os.tmpdir(), "swarmflow-provider-options-"));
const SAVED_ENV: Record<string, string | undefined> = {};

function contextWithProvider(provider: string): CommandOptionsContext {
  return {
    session: { primaryAgent: { modelConfig: { provider, model: "test-model" } } } as never,
  } as CommandOptionsContext;
}

function presetChildren(): CommandOption[] {
  const options = providerOptions(contextWithProvider("glm-code"), HOME);
  const presets = options.find((option) => option.value === "__presets__")!;
  return presets.children ?? [];
}

beforeEach(() => {
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.envVar) continue;
    SAVED_ENV[preset.envVar] ??= process.env[preset.envVar];
    delete process.env[preset.envVar];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("/provider 选项结构", () => {
  it("每个家族连续成节，节标题是不可提交的 section 行", () => {
    const children = presetChildren();
    const headings = children.filter((option) => option.section);
    expect(headings.length).toBeGreaterThan(1);

    for (const heading of headings) {
      expect(heading.disabled, heading.label).toBe(true);
      expect(heading.value, heading.label).toBe("");
      expect(heading.detail, heading.label).toMatch(/\d/);
    }

    // 按 section 切成节，逐节校验成员归属：家族被打散或串门就是回归。
    const sections: Array<{ label: string; members: CommandOption[] }> = [];
    for (const option of children) {
      if (option.section) sections.push({ label: option.label, members: [] });
      else if (sections.length > 0) sections[sections.length - 1]!.members.push(option);
    }
    expect(sections.reduce((sum, section) => sum + section.members.length, 0)).toBe(19);
    for (const section of sections) {
      for (const member of section.members) {
        const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === member.value)!;
        expect(preset.groupLabel ?? "独立供应商", member.value).toBe(section.label);
      }
    }
  });

  it("节内用注册表 subLabel 短名，未分组条目保留全名", () => {
    const children = presetChildren();
    const grouped = PROVIDER_PRESETS.filter((preset) => preset.subLabel && !preset.localServer);
    for (const preset of grouped) {
      const row = children.find((option) => option.value === preset.id)!;
      expect(row.label, preset.id).toBe(preset.subLabel);
    }
    const ungrouped = PROVIDER_PRESETS.filter((preset) => !preset.subLabel && !preset.localServer);
    for (const preset of ungrouped) {
      const row = children.find((option) => option.value === preset.id)!;
      expect(row.label, preset.id).toBe(preset.name);
    }
  });

  it("当前主模型所在的供应商标为使用中，其余只可能是已配置或未配置", () => {
    const children = presetChildren();
    const live = children.filter((option) => option.status?.tone === "live");
    expect(live.map((option) => option.value)).toEqual(["glm-code"]);
    expect(live[0]!.status!.text).toBe("使用中");

    for (const option of children) {
      if (option.section) {
        expect(option.status, option.label).toBeUndefined();
        continue;
      }
      if (option.status?.tone === "live") continue;
      expect(["ok", "off"], option.value).toContain(option.status?.tone);
      expect(["已配置", "未配置"], option.value).toContain(option.status?.text);
      // 清掉环境变量后，非当前 provider 不该被判成已就绪（OAuth 两家除外）。
      if (option.value !== "openai-codex" && option.value !== "copilot") {
        expect(option.status!.tone, option.value).toBe("off");
      }
    }
  });

  it("色标只在同组共享 group id 时上色，独立供应商节留中性", () => {
    const children = presetChildren();
    const headings = children.filter((option) => option.section);
    const standalone = headings.find((heading) => heading.label === "独立供应商")!;
    expect(standalone.spine).toBeUndefined();

    const zai = headings.find((heading) => heading.label === "z.ai (GLM/Zhipu)")!;
    expect(zai.spine).toBe("glm");

    for (const option of children) {
      if (option.section) continue;
      expect(option.spine, option.value).toBe(option.value);
    }
  });

  it("入口行带登录态与色标，preset 提交值仍是裸 provider id", () => {
    const options = providerOptions(contextWithProvider("glm-code"), HOME);
    const codex = options.find((option) => option.value === "__codex__")!;
    expect(codex.spine).toBe("openai-codex");
    expect(["ok", "off"]).toContain(codex.status!.tone);
    expect(["已登录", "未登录"]).toContain(codex.status!.text);

    const copilot = options.find((option) => option.value === "__copilot__")!;
    expect(copilot.spine).toBe("copilot");

    const presets = options.find((option) => option.value === "__presets__")!;
    expect(presets.spine).toBeUndefined();
    expect(presets.detail).toMatch(/19 家/);
    // 提交值决定 cmdProvider 的分流，不能被短名或分组改写。
    expect(presets.children!.find((option) => option.value === "kimi-code")!.label).toBe("Kimi-Code");
  });

  it("未登录且没有 key 的 provider 不会丢失状态，动作行不带状态灯", () => {
    const options = providerOptions(contextWithProvider(""), HOME);
    for (const option of options) {
      if (option.value === "__codex__" || option.value === "__copilot__") continue;
      expect(option.status, option.value).toBeUndefined();
    }
    const children = options.find((option) => option.value === "__presets__")!.children!;
    expect(children.some((option) => option.status?.tone === "live")).toBe(false);
  });
});
