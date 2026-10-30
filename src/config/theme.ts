/**
 * 主题模式（ThemeMode）的唯一真实来源。
 *
 * 只支持三种主题：brief（默认）、dark、light。历史遗留值（default / dracula /
 * nord / "auto"）在读取配置或解析命令参数时统一归一化，因此 UI 与持久层不会
 * 出现第四种主题。
 *
 * TUI（external/opentui）通过 re-export 复用本文件，避免两处硬编码。
 */

/** 可用主题模式。 */
export type ThemeMode = "brief" | "dark" | "light";

/** 全部主题模式（切换命令、选择器、解析器共用）。 */
export const THEME_MODES: readonly ThemeMode[] = ["brief", "dark", "light"];

/** 默认主题：Brief。 */
export const DEFAULT_THEME_MODE: ThemeMode = "brief";

/** 跟随终端的偏好值；不属于具体主题。 */
const AUTO_THEME_PREF = "auto" as const;

export type ThemeModePref = typeof AUTO_THEME_PREF | ThemeMode;

/** 将值解析为 ThemeModePref；无法识别时返回 null。 */
export function parseThemeModePref(value: string | undefined | null): ThemeModePref | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === AUTO_THEME_PREF) return "auto";
  return THEME_MODES.includes(v as ThemeMode) ? (v as ThemeMode) : null;
}

/**
 * 把任意输入归一化为受支持的主题模式。空值、未知值以及历史遗留值
 * （default / dracula / nord …）统一映射到默认主题 Brief。
 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  const pref = parseThemeModePref(typeof value === "string" ? value : undefined);
  if (pref && pref !== "auto") return pref;
  return DEFAULT_THEME_MODE;
}
