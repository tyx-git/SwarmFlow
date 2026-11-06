import { RGBA, TextareaRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  createComposerTokenVisuals,
  ensureSlashCommandType,
  refreshSlashCommandHighlight,
  type ComposerTokenVisuals,
} from "../../external/opentui/composer-tokens.js";
import { createDisplayTheme, type DisplayTheme } from "../../external/opentui/display/theme/index.js";

/**
 * 输入行的命令着色：只有已注册命令的 `/plan` 段拿到紫色 extmark。
 *
 * 断言落在可观察结果上——extmark 的区间/样式 id，以及捕获帧里出现的颜色；
 * 不锁实现细节（区间每键重算、用独立 typeId 这些属于内部约定）。
 */
describe("输入行斜杠命令着色", () => {
  const KNOWN = new Set(["/plan", "/compact", "/c"]);
  const isKnown = (token: string): boolean => KNOWN.has(token);

  const cleanups: Array<() => void> = [];

  async function mount(text: string): Promise<{
    setup: TestRendererSetup;
    composer: TextareaRenderable;
    visuals: ComposerTokenVisuals;
    theme: DisplayTheme;
  }> {
    const setup = await createTestRenderer({ width: 60, height: 6, useThread: false, consoleMode: "disabled" });
    const theme = createDisplayTheme("dark");
    const visuals = createComposerTokenVisuals(theme.colors);
    const composer = new TextareaRenderable(setup.renderer, {
      syntaxStyle: visuals.syntaxStyle,
      width: 60,
      height: 3,
      initialValue: text,
    });
    setup.renderer.root.add(composer);
    await setup.flush();
    cleanups.push(() => {
      setup.renderer.destroy();
      visuals.syntaxStyle.destroy();
      theme.markdownStyle.destroy();
    });
    return { setup, composer, visuals, theme };
  }

  function slashMarks(composer: TextareaRenderable) {
    return composer.extmarks.getAllForTypeId(ensureSlashCommandType(composer));
  }

  function spanColors(setup: TestRendererSetup): string[] {
    return setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .map((span) => (span.fg ? span.fg.toString() : ""));
  }

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("已注册命令得到一个覆盖令牌区间的非虚拟 extmark", async () => {
    const { composer, visuals } = await mount("/plan add a rule");

    refreshSlashCommandHighlight(composer, visuals, isKnown);

    const marks = slashMarks(composer);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.start).toBe(0);
    expect(marks[0]!.end).toBe(5);
    expect(marks[0]!.styleId).toBe(visuals.slashStyleId);
    // virtual:false —— 虚拟标记会让退格把整个命令词当成原子 token 一次删掉。
    expect(marks[0]!.virtual).toBe(false);
  });

  it("紫色令牌真的落到渲染帧上", async () => {
    const { setup, composer, visuals, theme } = await mount("/compact");

    refreshSlashCommandHighlight(composer, visuals, isKnown);
    // extmark 是在首帧之后建的，必须再走一帧才会体现在捕获的 span 上。
    await setup.flush();

    const purple = RGBA.fromHex(theme.colors.slashCommand).toString();
    expect(visuals.syntaxStyle.getStyle("composer.token.slash")?.fg?.toString()).toBe(purple);
    expect(spanColors(setup)).toContain(purple);
  });

  it("未注册的 /pall 不着色，也不留下旧的紫色帧", async () => {
    const { setup, composer, visuals, theme } = await mount("/plan done");
    refreshSlashCommandHighlight(composer, visuals, isKnown);
    await setup.flush();
    expect(spanColors(setup)).toContain(RGBA.fromHex(theme.colors.slashCommand).toString());

    composer.setText("/pall done");
    refreshSlashCommandHighlight(composer, visuals, isKnown);
    await setup.flush();

    expect(slashMarks(composer)).toHaveLength(0);
    expect(spanColors(setup)).not.toContain(RGBA.fromHex(theme.colors.slashCommand).toString());
  });

  it("重复刷新不累积标记，删掉开头的斜杠后也不会把 plan 留在紫色", async () => {
    const { composer, visuals } = await mount("/plan x");

    refreshSlashCommandHighlight(composer, visuals, isKnown);
    refreshSlashCommandHighlight(composer, visuals, isKnown);
    refreshSlashCommandHighlight(composer, visuals, isKnown);
    expect(slashMarks(composer)).toHaveLength(1);

    composer.cursorOffset = 1;
    composer.editBuffer.deleteCharBackward();
    refreshSlashCommandHighlight(composer, visuals, isKnown);

    expect(composer.plainText).toBe("plan x");
    expect(slashMarks(composer)).toHaveLength(0);
  });

  it("命令只在第一行开头时着色", async () => {
    const { composer, visuals } = await mount("say /plan now");
    refreshSlashCommandHighlight(composer, visuals, isKnown);
    expect(slashMarks(composer)).toHaveLength(0);
  });

  it("别名与主名同等对待，普通文本不受影响", async () => {
    const { composer, visuals } = await mount("/c brief note");
    refreshSlashCommandHighlight(composer, visuals, (token) => token === "/c");
    expect(slashMarks(composer)).toHaveLength(1);

    const { composer: plain } = await mount("hello world");
    refreshSlashCommandHighlight(plain, visuals, isKnown);
    expect(slashMarks(plain)).toHaveLength(0);
  });
});
