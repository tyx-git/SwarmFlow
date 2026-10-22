import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_LANGUAGE,
  createUiText,
  hasUiText,
  uiTextTree,
  normalizeUiLanguage,
  resolveCommandEchoDisplay,
  uiTextKeys,
  type UiTextModule,
} from "../../src/ui/text.js";
import {
  THEME_MODES,
  DEFAULT_THEME_MODE,
  normalizeThemeMode,
  parseThemeModePref,
} from "../../src/config/theme.js";
import { THINKING_LEVEL_LIST } from "../../src/config/thinking.js";
import { createDisplayTheme, getCommonColors, getThemeColors } from "../../external/opentui/display/theme/index.js";

const MODULES: UiTextModule[] = ["Common", "Error", "Commands", "Views", "Init"];

/** 递归列出某个语言分区下的全部叶子路径。 */
function leafPaths(node: unknown, prefix: string[] = []): string[] {
  if (typeof node === "string") return [prefix.join(".")];
  if (!node || typeof node !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("$")) continue;
    out.push(...leafPaths(value, [...prefix, key]));
  }
  return out;
}

// ------------------------------------------------------------------
// language.json 结构
// ------------------------------------------------------------------

describe("language.json", () => {
  it("exposes Chinese and English with identical key sets (parity)", () => {
    const zh = leafPaths(uiTextTree("zh"));
    const en = leafPaths(uiTextTree("en"));
    expect(en.length).toBeGreaterThan(0);
    expect(en).toEqual(zh);
  });

  it("ships the documented modules", () => {
    for (const module of MODULES) {
      expect(uiTextKeys("zh", module).length).toBeGreaterThan(0);
      expect(uiTextKeys("en", module).length).toBeGreaterThan(0);
    }
  });

  it("has no empty string anywhere", () => {
    for (const lang of ["zh", "en"] as const) {
      const t = createUiText(lang);
      for (const path of leafPaths(uiTextTree(lang))) {
        expect(t.get(path.split(".")).length).toBeGreaterThan(0);
      }
    }
  });

  it("throws a helpful error for a missing path", () => {
    const t = createUiText("zh");
    expect(() => t.get(["Views", "does", "not", "exist"])).toThrow(/language.json: missing/);
  });

  it("substitutes placeholders and leaves unknown ones visible", () => {
    const t = createUiText("zh");
    expect(t.get(["Error", "unknownCommand"], { command: "/nope" })).toContain("/nope");
    expect(t.get(["Error", "imagePasteFailed"], {})).toContain("{message}");
  });
});

// ------------------------------------------------------------------
// 6) 命令回显
// ------------------------------------------------------------------

describe("command echo display", () => {
  it("replaces the raw command text with the Chinese template + argument", () => {
    expect(resolveCommandEchoDisplay("/theme Brief", "zh")).toBe("主题切换为 Brief");
  });

  it("replaces the raw command text with the English template", () => {
    expect(resolveCommandEchoDisplay("/theme Brief", "en")).toBe("Theme switched to Brief");
  });

  it("keeps every argument (not just the first token)", () => {
    expect(resolveCommandEchoDisplay("/skills a b c", "zh")).toBe("技能切换为 a b c");
  });

  it("localizes the /permission mode argument", () => {
    expect(resolveCommandEchoDisplay("/permission yolo", "zh")).toBe("权限模式切换为: 完全访问");
    expect(resolveCommandEchoDisplay("/permission reversible", "zh")).toBe("权限模式切换为: 自动审批");
    expect(resolveCommandEchoDisplay("/permission read_only", "en")).toBe("Permission mode switched to: Read-only");
  });

  it("shows the bare text when the command has no argument", () => {
    expect(resolveCommandEchoDisplay("/theme", "zh")).toBe("主题切换为");
  });

  it("falls back to null for untracked commands (caller keeps raw text)", () => {
    expect(resolveCommandEchoDisplay("/help", "zh")).toBeNull();
    expect(resolveCommandEchoDisplay("hello", "zh")).toBeNull();
  });

  it("covers the switch-style commands", () => {
    const commands = uiTextKeys("zh", "Commands");
    for (const cmd of commands) {
      expect(uiTextKeys("en", "Commands")).toContain(cmd);
      if (!hasUiText("zh", ["Commands", cmd, "echo"])) continue;
      expect(resolveCommandEchoDisplay(`${cmd} x`, "zh")).not.toBeNull();
      expect(resolveCommandEchoDisplay(`${cmd} x`, "en")).not.toBeNull();
    }
    expect(commands).toContain("/theme");
    expect(commands).not.toContain("/effort");
  });

  it("normalizes unknown languages to the default", () => {
    expect(normalizeUiLanguage("fr")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage("EN")).toBe("en");
    expect(normalizeUiLanguage("zh-CN")).toBe("zh");
  });
});

// ------------------------------------------------------------------
// 5) 初始化向导
// ------------------------------------------------------------------

describe("init wizard texts", () => {
  const paths: string[][] = [
    ["language", "title"], ["banner", "title"], ["banner", "backHint"],
    ["search", "prompt"], ["search", "detected"], ["search", "signUp"],
    ["theme", "prompt"], ["theme", "brief"], ["theme", "dark"], ["theme", "light"], ["theme", "saved"],
    ["provider", "ask"], ["provider", "yes"], ["provider", "later"], ["provider", "label"],
    ["provider", "endpointUrl"], ["provider", "protocol"], ["provider", "protocolChoices", "openai-chat"],
    ["provider", "protocolChoices", "openai-responses"], ["provider", "protocolChoices", "anthropic"],
    ["provider", "protocolChoices", "gemini"], ["provider", "apiKey"],
    ["provider", "modelId"], ["provider", "contextLength"], ["provider", "added"],
    ["wizard", "complete"], ["wizard", "hintProviders"],
  ];

  it("has both languages for every wizard path", () => {
    for (const path of paths) {
      expect(hasUiText("zh", ["Init", ...path])).toBe(true);
      expect(hasUiText("en", ["Init", ...path])).toBe(true);
    }
  });

  it("substitutes {var} placeholders", () => {
    const zh = createUiText("zh");
    expect(zh.get(["Init", "search", "detected"], { name: "Tavily", env: "TAVILY_API_KEY" })).toContain("Tavily");
    expect(zh.get(["Init", "provider", "added"], { label: "JuCode", model: "gpt-5" })).toContain("JuCode");
  });

  it("the baseURL example no longer includes the endpoint path", () => {
    for (const lang of ["zh", "en"] as const) {
      const example = createUiText(lang).get(["Init", "provider", "endpointUrl"], { label: "X", protocol: "OpenAI Chat Completions" });
      expect(example).toContain("https://api.example.com/v1");
      expect(example).toContain("OpenAI Chat Completions");
    }
  });
});

// ------------------------------------------------------------------
// 1) 主题
// ------------------------------------------------------------------

describe("theme modes", () => {
  it("loads color tokens from assets/ui-colors/color.json", () => {
    expect(getCommonColors().workingStatus).toMatch(/^#[0-9a-f]{6,8}$/i);
    expect(getCommonColors().workedStatus).toMatch(/^#[0-9a-f]{6,8}$/i);
    for (const mode of ["brief", "dark", "light"] as const) {
      expect(getThemeColors(mode).colors.accent).toMatch(/^#[0-9a-f]{6,8}$/i);
      const theme = getThemeColors(mode);
      expect(theme.markdown.syntax.strong).toMatch(/^#[0-9a-f]{6,8}$/i);
      expect(theme.markdown.syntax.strong.toLowerCase()).not.toBe(theme.colors.text.toLowerCase());
      expect(theme.markdown.syntax.headingPrimary).toMatch(/^#[0-9a-f]{6,8}$/i);
      expect(theme.markdown.syntax.raw).toMatch(/^#[0-9a-f]{6,8}$/i);
      expect(theme.markdown.syntax.raw.toLowerCase()).not.toBe(theme.colors.text.toLowerCase());
    }
  });
  it("only exposes brief / dark / light", () => {
    expect([...THEME_MODES].sort()).toEqual(["brief", "dark", "light"]);
  });

  it("defaults to brief", () => {
    expect(DEFAULT_THEME_MODE).toBe("brief");
    expect(normalizeThemeMode(undefined)).toBe("brief");
    expect(normalizeThemeMode("")).toBe("brief");
  });

  it("maps legacy values to the default theme", () => {
    for (const legacy of ["default", "dracula", "nord", "auto", "???", null]) {
      expect(normalizeThemeMode(legacy)).toBe("brief");
    }
  });

  it("parses valid values and rejects unknown ones", () => {
    expect(parseThemeModePref("Brief")).toBe("brief");
    expect(parseThemeModePref("dark")).toBe("dark");
    expect(parseThemeModePref("light")).toBe("light");
    expect(parseThemeModePref("auto")).toBe("auto");
    expect(parseThemeModePref("dracula")).toBeNull();
  });

  it("builds themes for all three modes", () => {
    for (const mode of THEME_MODES) {
      expect(createDisplayTheme(mode).mode).toBe(mode);
    }
  });

  it("refuses to build an unknown theme", () => {
    expect(() => createDisplayTheme("dracula" as never)).toThrow(/unknown theme mode/);
  });
});

// ------------------------------------------------------------------
// 3) 思考深度
// ------------------------------------------------------------------

describe("thinking depth", () => {
  it("ships the default off/low/medium/high/xhigh/max options", () => {
    expect(THINKING_LEVEL_LIST).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  it("uses settings.json for additional or reduced options", () => {
    expect(THINKING_LEVEL_LIST).toContain("off");
    expect(THINKING_LEVEL_LIST).toContain("max");
  });
});
