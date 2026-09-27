import {
  DEFAULT_THEME_MODE,
  parseThemeModePref,
  type ThemeMode,
  type ThemeModePref,
} from "../../src/config/theme.js";

export type { ThemeMode, ThemeModePref };
export { DEFAULT_THEME_MODE, parseThemeModePref };

/**
 * Read the THEME env var. Returns null if unset or invalid.
 */
function readEnvThemePref(): ThemeModePref | null {
  return parseThemeModePref(process.env.THEME);
}

/**
 * Heuristic from terminal env vars when OSC detection fails.
 *
 *  - COLORFGBG: classic xterm/rxvt convention "fg;bg" (bg index 0=black..15=white).
 *    Indices >= 8 are bright/light backgrounds.
 *  - TERM_PROGRAM: "Apple_Terminal", "iTerm.app", "vscode", etc. We deliberately
 *    don't try to peek their preferences here — too brittle. COLORFGBG is the
 *    only reliable signal.
 */
function inferThemeFromEnvHints(): ThemeMode | null {
  const fgBg = process.env.COLORFGBG;
  if (fgBg) {
    const parts = fgBg.split(";");
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg)) {
      // 0–6 are dark ANSI bg colors, 7+ are light.
      return bg >= 7 ? "light" : "dark";
    }
  }
  return null;
}

interface RendererLike {
  waitForThemeMode: (timeoutMs?: number) => Promise<ThemeMode | null>;
}

export interface ResolvedThemeMode {
  /** Final mode used to build the theme. */
  mode: ThemeMode;
  /** "auto" if we should follow terminal theme_mode events; concrete mode if pinned. */
  pref: ThemeModePref;
  /** Where the answer came from — for diagnostics. */
  source: "env" | "settings" | "osc" | "env-hint" | "fallback";
}

/**
 * Resolve the effective theme mode at startup.
 *
 * Precedence (high → low):
 *   1. THEME env
 *   2. settings.theme_mode (if not "auto")
 *   3. OSC OSC 10/11 query via renderer.waitForThemeMode(timeoutMs)
 *   4. Terminal env hint (COLORFGBG)
 *   5. dark fallback (with a stderr warning so it's not silent)
 */
export async function resolveThemeMode(
  renderer: RendererLike,
  settingsPref: ThemeModePref | undefined,
  oscTimeoutMs: number = 250,
): Promise<ResolvedThemeMode> {
  // 1. env
  const envPref = readEnvThemePref();
  if (envPref && envPref !== "auto") {
    return { mode: envPref, pref: envPref, source: "env" };
  }

  // 2. settings (concrete mode wins)
  if (settingsPref && settingsPref !== "auto") {
    return { mode: settingsPref, pref: settingsPref, source: "settings" };
  }

  // We're now in auto. Either env said "auto" explicitly, settings said "auto",
  // or neither was set (= default auto). Either way, follow the terminal.
  const pref: ThemeModePref = "auto";

  // 3. OSC
  const osc = await renderer.waitForThemeMode(oscTimeoutMs);
  if (osc) {
    return { mode: osc, pref, source: "osc" };
  }

  // 4. env hint
  // auto 模式下的兜底：统一落到默认主题（Brief）。
  const hint = inferThemeFromEnvHints();
  if (hint) {
    return { mode: hint, pref, source: "env-hint" };
  }

  // 5. fallback
  return { mode: DEFAULT_THEME_MODE, pref, source: "fallback" };
}
