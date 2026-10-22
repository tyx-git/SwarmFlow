import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGlobalSettings, saveGlobalSettingsPatch, globalSettingsPath } from "../../src/config/settings/io.js";
import { normalizeUiLanguage } from "../../src/ui/text.js";
import { normalizeThemeMode } from "../../src/config/theme.js";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sf-settings-"));
  mkdirSync(join(home, "prompts", "templates"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  return home;
}

describe("ui_language persistence", () => {
  it("round-trips through settings.json", () => {
    const home = makeHome();
    try {
      saveGlobalSettingsPatch({ ui_language: "en" }, home);
      expect(loadGlobalSettings(home).ui_language).toBe("en");
      saveGlobalSettingsPatch({ ui_language: "zh" }, home);
      expect(loadGlobalSettings(home).ui_language).toBe("zh");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps other fields when patching ui_language", () => {
    const home = makeHome();
    try {
      saveGlobalSettingsPatch({ theme_mode: "dark" }, home);
      saveGlobalSettingsPatch({ ui_language: "en" }, home);
      const settings = loadGlobalSettings(home);
      expect(settings.theme_mode).toBe("dark");
      expect(settings.ui_language).toBe("en");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the file next to other settings", () => {
    const home = makeHome();
    try {
      saveGlobalSettingsPatch({ ui_language: "zh" }, home);
      expect(readFileSync(globalSettingsPath(home), "utf-8")).toContain("ui_language");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("normalizes whatever is stored", () => {
    expect(normalizeUiLanguage("zh")).toBe("zh");
    expect(normalizeUiLanguage("en")).toBe("en");
    expect(normalizeUiLanguage(undefined)).toBe("zh");
    expect(normalizeUiLanguage("klingon")).toBe("zh");
  });
});

describe("theme_mode normalization", () => {
  it("drops removed themes when read back", () => {
    const home = makeHome();
    try {
      writeFileSync(
        globalSettingsPath(home),
        JSON.stringify({ version: 1, theme_mode: "dracula" }),
        "utf-8",
      );
      expect(loadGlobalSettings(home).theme_mode).toBe("dracula"); // 原样读回
      expect(normalizeThemeMode(loadGlobalSettings(home).theme_mode)).toBe("brief"); // 归一化后只剩三种
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("round-trips supported modes", () => {
    const home = makeHome();
    try {
      for (const mode of ["brief", "dark", "light"] as const) {
        saveGlobalSettingsPatch({ theme_mode: mode }, home);
        expect(loadGlobalSettings(home).theme_mode).toBe(mode);
        expect(normalizeThemeMode(loadGlobalSettings(home).theme_mode)).toBe(mode);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
