import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createUiText,
  resolveCommandEchoDisplay,
  UI_LANGUAGES,
  normalizeUiLanguage,
  uiTextKeys,
} from "../src/lib/ui-text.js";
import { buildDefaultRegistry } from "../src/commands/commands.js";

describe("/language command", () => {
  it("is registered", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/language");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("/language");
    // 别名式中文写法也应可查（命令表按 /language 索引）
    expect(registry.lookup("/lang")).toBeUndefined();
  });

  it("has an echo entry in both languages", () => {
    const commands = uiTextKeys("zh", "Commands");
    expect(commands).toContain("/language");
    expect(uiTextKeys("en", "Commands")).toContain("/language");
    expect(createUiText("zh").get(["Commands", "/language", "echo"])).toBe("界面语言切换为");
    expect(createUiText("en").get(["Commands", "/language", "echo"])).toBe("UI language switched to");
  });

  it("echoes the chosen language instead of the raw command", () => {
    expect(resolveCommandEchoDisplay("/language zh", "zh")).toBe("界面语言切换为 zh");
    expect(resolveCommandEchoDisplay("/language en", "en")).toBe("UI language switched to en");
    expect(resolveCommandEchoDisplay("/language", "zh")).toBe("界面语言切换为");
  });

  it("persists ui_language and normalizes input", async () => {
    const home = mkdtempSync(join(tmpdir(), "sf-langcmd-"));
    mkdirSync(join(home, "prompts", "templates"), { recursive: true });
    mkdirSync(join(home, "skills"), { recursive: true });
    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/language")!;
      const seen: string[] = [];
      const ctx: any = {
        swarmflowHomeDir: home,
        showMessage: (m: string) => seen.push(m),
        showHint: (m: string) => seen.push(m),
        store: undefined,
      };
      await cmd.handler(ctx, "en");
      // 魔术消息交给 TUI
      expect(seen).toContain("__ui_language__:en");
      expect(normalizeUiLanguage("en")).toBe("en");
      // 再次读：中文别名也应归一化
      await cmd.handler(ctx, "chinese");
      expect(seen.some((m) => m.startsWith("__ui_language__:zh"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows usage for an unknown value", async () => {
    const home = mkdtempSync(join(tmpdir(), "sf-langcmd2-"));
    mkdirSync(join(home, "prompts", "templates"), { recursive: true });
    mkdirSync(join(home, "skills"), { recursive: true });
    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/language")!;
      const seen: string[] = [];
      await cmd.handler(
        {
          swarmflowHomeDir: home,
          showMessage: (m: string) => seen.push(m),
          showHint: (m: string) => seen.push(m),
        } as any,
        "klignon",
      );
      const joined = seen.join("\n");
      expect(joined).toContain("/language");
      expect(joined).toContain("zh | en");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("offers exactly zh and en", () => {
    expect(UI_LANGUAGES).toEqual(["zh", "en"]);
  });
});
