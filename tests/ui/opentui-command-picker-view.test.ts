/**
 * 线路牌选择器的真实渲染：色标列、状态灯、面包屑 + 计数、节标题点线，
 * 以及 inputArea 选择器也输出键位脚注。断言取自无头字符帧与 span 颜色。
 */

import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acceptCommandPickerSelection,
  createCommandPicker,
  getCommandPickerLevel,
  getCommandPickerVisibleRange,
  moveCommandPickerSelection,
  setCommandPickerSelection,
  type CommandPickerState,
} from "../../src/ui/command-picker.js";
import { providerOptions } from "../../src/commands/provider/options.js";
import type { CommandOption } from "../../src/commands/types.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { CommandPickerView } from "../../external/opentui/display/overlays/views.js";
import { resolveSpineColor } from "../../external/opentui/display/utils/model.js";
import type { DisplayTheme } from "../../external/opentui/display/theme/index.js";

const HOME = mkdtempSync(path.join(os.tmpdir(), "swarmflow-picker-view-"));
const WIDTH = 110;
const LIVE_PROVIDER = "glm-code";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function pickerContext(): never {
  return {
    session: { primaryAgent: { modelConfig: { provider: LIVE_PROVIDER, model: "glm-coding" } } } as never,
  } as never;
}

function rootOptions(): CommandOption[] {
  return providerOptions(pickerContext(), HOME);
}

function entryPicker(): CommandPickerState {
  return createCommandPicker("/provider", rootOptions(), 5, undefined, false, true);
}

/** 走到“常用供应商”这一层，全程用真实的选项构建与下钻路径。 */
function presetsPicker(): CommandPickerState {
  const options = rootOptions();
  const picker = entryPicker();
  const presetsIndex = options.findIndex((option) => option.value === "__presets__");
  const drilled = acceptCommandPickerSelection({
    ...picker,
    stack: [{ ...picker.stack[0]!, selected: presetsIndex }],
  });
  if (drilled?.kind !== "drill_down") throw new Error("常用供应商应当下钻");
  return drilled.picker;
}

async function render(picker: CommandPickerState, theme: DisplayTheme): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: WIDTH + 4, height: 12, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(CommandPickerView, {
    picker,
    theme,
    contentWidth: WIDTH,
    maxVisible: 5,
    language: "zh",
    onItemClick: () => {},
  })));
  await setup.flush({ maxPasses: 100 });
  cleanups.push(() => {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
    theme.markdownStyle.destroy();
  });
  return setup;
}

const frameLines = (setup: TestRendererSetup): string[] => setup.captureCharFrame().split("\n");
const frame = (setup: TestRendererSetup): string => frameLines(setup).join("\n");
const spanColors = (setup: TestRendererSetup): string[] =>
  setup.captureSpans().lines.flatMap((line) => line.spans).map((span) => (span.fg ? span.fg.toString() : ""));
const hex = (value: string): string => RGBA.fromHex(value).toString();

describe("线路牌选择器渲染", () => {
  it("入口标题本地化，带项数与位置读数，脚注不再缺席", async () => {
    const setup = await render(entryPicker(), createDisplayTheme("dark"));
    const text = frame(setup);
    // 只看标题行：选项标签里本来就有“常用供应商”，不能替标题作证。
    const head = frameLines(setup).find((line) => /项\s+\d+\//.test(line));

    // 曾经是硬编码英文 "Providers"，中文界面也显示英文。
    expect(head, "标题行缺失").toBeDefined();
    expect(head).toContain("供应商");
    expect(head).not.toContain("/provider");
    expect(text).not.toContain("Providers");
    // 计数只统计可提交行，节标题不算。
    expect(head).toMatch(/5 项\s+1\/5/);
    expect(text).toContain("↑↓");
  });

  it("窗口内每行都给出色标列，选中行只有一个 ❯", async () => {
    const setup = await render(presetsPicker(), createDisplayTheme("dark"));
    const rows = frameLines(setup).filter((line) => line.includes("▐"));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.trimStart().startsWith("▐")).toBe(true);
    expect(frame(setup).match(/❯/g)).toHaveLength(1);
  });

  it("未选中行的色标取该行品牌色，选中行换成 accent", async () => {
    const theme = createDisplayTheme("dark");
    const picker = presetsPicker();
    const setup = await render(picker, theme);
    const level = getCommandPickerLevel(picker);
    const { start, end } = getCommandPickerVisibleRange(picker);
    const colors = spanColors(setup);

    // 期望色直接取自主题数据，不经过被测函数，避免自证。
    const expected = level.options.slice(start, end)
      .filter((option, index) => option.spine && start + index !== level.selected)
      .map((option) => hex(theme.presentation.modelProviderColors[option.spine!] ?? theme.colors.muted));
    const distinct = new Set(expected);
    expect(distinct.size, "色标必须真的分厂商变色，而不是一律 accent").toBeGreaterThan(1);
    for (const color of distinct) expect(colors, color).toContain(color);
    expect(colors).toContain(hex(theme.colors.accent));
    // 未登记的厂商（qwen 等）落到 muted，不借用邻家颜色。
    expect(theme.presentation.modelProviderColors.qwen).toBeUndefined();
    expect(resolveSpineColor(theme, "qwen")).toBe(theme.colors.muted);
  });

  it("当前 provider 行显示使用中，状态灯落在行右侧", async () => {
    const theme = createDisplayTheme("dark");
    let picker = presetsPicker();
    const level = getCommandPickerLevel(picker);
    const liveIndex = level.options.findIndex((option) => option.value === LIVE_PROVIDER);
    expect(liveIndex).toBeGreaterThan(0);
    picker = setCommandPickerSelection(picker, liveIndex);

    const setup = await render(picker, theme);
    const line = frameLines(setup).find((row) => row.includes("使用中"));
    expect(line, "使用中应随窗口滚动出现").toBeDefined();
    expect(frame(setup).match(/使用中/g)).toHaveLength(1);
    // 状态灯在名称右侧，不占标题左侧空间。
    expect(line!.indexOf("使用中")).toBeGreaterThan(line!.indexOf("GLM"));
    expect(line).toContain("●");
    expect(frame(setup)).toMatch(/—|✓/);
  });

  it("节标题用品牌色与连续点线，选择永远不停在它上面", async () => {
    const theme = createDisplayTheme("dark");
    const picker = presetsPicker();
    const setup = await render(picker, theme);
    const section = frameLines(setup).find((line) => /▐.*·{3}/.test(line));
    expect(section, "节标题应当以点线填充到计数列").toBeDefined();
    expect(section).toMatch(/·+.*\d+ 家/);
    expect(section).not.toContain("...");

    const level = getCommandPickerLevel(picker);
    let moved = picker;
    for (let step = 0; step < level.options.length + 2; step += 1) {
      moved = moveCommandPickerSelection(moved, 1);
      const current = getCommandPickerLevel(moved).options[getCommandPickerLevel(moved).selected];
      expect(current.section, "节标题不能进入选中").toBeFalsy();
    }
  });

  it("面包屑挂在标题右侧，层级路径不重复", async () => {
    const setup = await render(presetsPicker(), createDisplayTheme("dark"));
    const head = frameLines(setup).find((line) => line.includes("供应商 › "))!;
    expect(head).toContain("常用供应商");
    expect(head.match(/常用供应商/g)).toHaveLength(1);
  });

  it("三列技能行保持原排版，不套用线路牌列", async () => {
    const theme = createDisplayTheme("dark");
    const picker = createCommandPicker("/skills", [
      { labelPrefix: "on", label: "demo", value: "demo", detail: "描述" },
      { labelPrefix: "off", label: "other", value: "other", detail: "描述" },
    ], 5, "技能:", false, true, "toggle");
    const setup = await render(picker, theme);
    const text = frame(setup);
    expect(text).not.toContain("▐");
    expect(text).toContain("demo");
  });
});
