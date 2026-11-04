import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { RGBA } from "@opentui/core";

import { FileModifyBody } from "../../external/opentui/components/entry/file-modify-body.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { buildWriteDisplayData } from "../../src/patches/hunk.js";

/**
 * Write（edit 的 Add File）使用“新增行”样式：行号 + `+`，整行绿色底。
 * 只断言可观察结果（字符帧 + span 背景色），不锁实现。
 */

interface Rendered {
  rows: string[];
  backgrounds: Array<string | undefined>;
  additionBg: string;
}

async function render(data: ReturnType<typeof buildWriteDisplayData>): Promise<Rendered> {
  const theme = createDisplayTheme("dark");
  const setup = await createTestRenderer({ width: 50, height: 10, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() => root.render(React.createElement(FileModifyBody as any, {
      data,
      colors: theme.colors,
      contentWidth: 46,
      maxVisibleLines: Number.POSITIVE_INFINITY,
    })));
    await setup.flush({ maxPasses: 100 });
    const rows = setup.captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "");
    const backgrounds = setup.captureSpans().lines
      .flatMap((line) => line.spans)
      .filter((span: any) => span.text.trim() !== "")
      .map((span: any) => span.bg?.toString());
    return { rows, backgrounds, additionBg: RGBA.fromHex(theme.colors.diffAdditionBg).toString() };
  } finally {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
    theme.markdownStyle.destroy();
  }
}

describe("write body uses the addition style", () => {
  it("prefixes every write line with + and paints it on the addition background", async () => {
    const rendered = await render(buildWriteDisplayData("src/a.ts", "const a = 1;\nconst b = 2;", 0));
    expect(rendered.rows[0]).toContain("1 +const a = 1;");
    expect(rendered.rows[1]).toContain("2 +const b = 2;");
    expect(new Set(rendered.backgrounds)).toEqual(new Set([rendered.additionBg]));
  });

  it("does not paint blank content lines as additions with text", async () => {
    const rendered = await render(buildWriteDisplayData("src/a.ts", "a\n\nb", 0));
    expect(rendered.rows[0]).toContain("1 +a");
    expect(rendered.rows[1]).toContain("2 +");
    expect(rendered.rows[2]).toContain("3 +b");
  });
});
