/**
 * UI 文案表（language.json 驱动，代码里不写死字符串）。
 *
 * 数据来源：`assets/ui-texts/language.json`，结构如下：
 *
 *   {
 *     "Chinese": { "Common": {...}, "Error": {...}, "Commands": {...}, "Views": {...}, "Init": {...} },
 *     "English": { ... }
 *   }
 *
 * - 顶层键固定 Chinese / English
 * - 第二层为模块：Common / Error / Commands / Views / Init（可继续追加）
 * - `Commands` 的第二层键是命令名（例如 "/theme"），其下是 echo / usage / … 子键
 * - `{var}` 为占位符，由 fillTemplate 替换
 *
 * 新增文案只改 JSON；两份语言的键集合必须一致（tests/ui-texts-and-theme.test.ts 校验）。
 */

import languageTable from "../../assets/ui-texts/language.json" with { type: "json" };
import { loadGlobalSettings } from "../config/settings/io.js";

// ------------------------------------------------------------------
// 语言
// ------------------------------------------------------------------

/** 界面语言。 */
export type UiLanguage = "zh" | "en";

export const DEFAULT_UI_LANGUAGE: UiLanguage = "zh";

/** 受支持的界面语言（/language 命令与选择器共用）。 */
export const UI_LANGUAGES: readonly UiLanguage[] = ["zh", "en"];

/** JSON 顶层分区名。 */
const SECTIONS: Record<UiLanguage, "Chinese" | "English"> = {
  zh: "Chinese",
  en: "English",
};

/** 把任意输入归一化为受支持的语言；无法识别时回落默认语言。 */
export function normalizeUiLanguage(value: unknown): UiLanguage {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "en" || v === "english" || v.startsWith("en-")) return "en";
  if (v === "zh" || v === "cn" || v === "chinese" || v.startsWith("zh-")) return "zh";
  return DEFAULT_UI_LANGUAGE;
}

/** JSON 里以 `$` 开头的键是注释/元数据，不是文案条目。 */
const META_KEYS = new Set(["$comment", "$schema", "$version"]);

/** 文案模块名（第二层键）。 */
export type UiTextModule = "Common" | "Error" | "Commands" | "Views" | "Init";

// ------------------------------------------------------------------
// 取值
// ------------------------------------------------------------------

/** 把 `{name}` 占位符替换为 vars 里的值；缺失的键保留原样以便排查。 */
function fillTemplate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => {
    const value = vars[key];
    return value === undefined ? raw : String(value);
  });
}

/** 某个语言分区下的整棵文案树。 */
function section(language: UiLanguage): Record<string, unknown> {
  const record = languageTable as unknown as Record<string, Record<string, unknown>>;
  const value = record[SECTIONS[language]];
  if (!value) {
    throw new Error(`language.json: missing "${SECTIONS[language]}" section`);
  }
  return value;
}

function lookup(language: UiLanguage, path: readonly string[]): string | undefined {
  let node: unknown = section(language);
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/** 某个语言分区下的整棵文案树（供测试做键集合/非空校验）。 */
export function uiTextTree(language: UiLanguage): Record<string, unknown> {
  return section(language);
}

/** 文案条目是否存在（用于测试/校验）。 */
export function hasUiText(language: UiLanguage, path: readonly string[]): boolean {
  return lookup(language, path) !== undefined;
}

/** 列出一个模块下的全部键（跳过 $ 注释键）。 */
export function uiTextKeys(language: UiLanguage, module: UiTextModule): string[] {
  const node = section(language)[module];
  if (!node || typeof node !== "object") return [];
  return Object.keys(node as Record<string, unknown>).filter((k) => !META_KEYS.has(k));
}

export interface UiText {
  readonly language: UiLanguage;
  /** 按模块/键取文案；例如 t.get(["Views", "permission", "yolo"])。 */
  get(path: readonly string[], vars?: Record<string, string | number>): string;
}

/** 构造一个文案读取器。 */
export function createUiText(language: UiLanguage = DEFAULT_UI_LANGUAGE): UiText {
  const lang = normalizeUiLanguage(language);
  return {
    language: lang,
    get(path, vars) {
      const value = lookup(lang, path);
      if (value === undefined) {
        throw new Error(`language.json: missing [${SECTIONS[lang]}].${path.join(".")}`);
      }
      return fillTemplate(value, vars);
    },
  };
}

/**
 * 当前界面语言：读全局设置里的 `ui_language`（安装向导写入）。
 * 读取失败时回落默认语言，保证 UI 不会因为配置缺失而崩。
 */
export function getUiLanguage(homeDir?: string): UiLanguage {
  try {
    return normalizeUiLanguage(loadGlobalSettings(homeDir).ui_language);
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

// ------------------------------------------------------------------
// 命令回显
// ------------------------------------------------------------------

/** Commands 模块下的全部命令名。 */
const ECHO_COMMANDS: ReadonlySet<string> = new Set(uiTextKeys(DEFAULT_UI_LANGUAGE, "Commands"));

/**
 * 把用户输入的命令行转换成"回显文案"。
 *
 * - 输入 `/theme Brief` → `主题切换为 Brief`（有参数时追加参数）
 * - 在 `/model` 最后一步选择思考深度     → `思考深度切换为`（无参数时只显示文案本身）
 * - 未登记的命令/普通文本 → 返回 null，调用方按原样显示
 */
export function resolveCommandEchoDisplay(input: string, language: UiLanguage = DEFAULT_UI_LANGUAGE): string | null {
  if (!input.startsWith("/")) return null;
  const [cmdName, ...rest] = input.trim().split(/\s+/);
  const command = cmdName ?? "";
  if (!ECHO_COMMANDS.has(command)) return null;
  if (!hasUiText(language, ["Commands", command, "echo"])) return null;
  const text = createUiText(language).get(["Commands", command, "echo"]);
  const args = rest.join(" ").trim();
  // 权限模式是内部键（yolo 等），回显给用户时换成可读名称。
  const permissionLabelKey = args === "read_only" ? "readOnly" : args === "reversible" ? "autoApprove" : args === "yolo" ? "fullAccess" : undefined;
  if (command === "/permission" && permissionLabelKey) {
    return `${text}: ${createUiText(language).get(["Commands", "/permission", permissionLabelKey])}`;
  }
  return args ? `${text} ${args}` : text;
}
