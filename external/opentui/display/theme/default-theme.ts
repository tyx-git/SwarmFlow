import { RGBA, SyntaxStyle } from "@opentui/core";

import type {
  DeepPartial,
  DisplayTheme,
  DisplayThemeColorTokens,
  DisplayThemeTokens,
  ThemeMode,
} from "./types.js";
import { DARK_TOKENS } from "./tokens-dark.js";
import { LIGHT_TOKENS } from "./tokens-light.js";

function mergeNested<T extends object>(base: T, overrides?: DeepPartial<T>): T {
  if (!overrides) return { ...base };
  const baseRecord = base as Record<string, unknown>;
  const overridesRecord = overrides as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };

  for (const key of Object.keys(overridesRecord)) {
    const overrideValue = overridesRecord[key];
    if (overrideValue === undefined) continue;
    const baseValue = baseRecord[key];

    if (
      baseValue &&
      overrideValue &&
      typeof baseValue === "object" &&
      typeof overrideValue === "object" &&
      !Array.isArray(baseValue) &&
      !Array.isArray(overrideValue)
    ) {
      result[key as string] = mergeNested(
        baseValue as Record<string, unknown>,
        overrideValue as DeepPartial<Record<string, unknown>>,
      );
      continue;
    }

    result[key as string] = overrideValue;
  }

  return result as T;
}

function buildMarkdownStyle(colors: DisplayThemeColorTokens, tokens: DisplayThemeTokens["markdown"]): SyntaxStyle {
  const kw = RGBA.fromHex(tokens.syntax.keyword);
  const str = RGBA.fromHex(tokens.syntax.string);
  const fn = RGBA.fromHex(tokens.syntax.function);
  const typ = RGBA.fromHex(tokens.syntax.type);
  const num = RGBA.fromHex(tokens.syntax.number);
  const cmt = RGBA.fromHex(tokens.syntax.comment);
  const op = RGBA.fromHex(tokens.syntax.operator);
  const lit = RGBA.fromHex(tokens.syntax.literal);

  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.text) },
    conceal: { fg: RGBA.fromHex(colors.dim) },
    "markup.heading": { fg: RGBA.fromHex(tokens.syntax.headingSecondary), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(tokens.syntax.headingSecondary), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(tokens.syntax.headingSecondary), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.4": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.5": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.6": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.table": { fg: RGBA.fromHex(colors.cyan), bold: true },
    "markup.strong": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.italic": { fg: RGBA.fromHex(colors.text), italic: true },
    "markup.raw": { fg: RGBA.fromHex(tokens.syntax.raw) },
    "markup.raw.block": { fg: RGBA.fromHex(tokens.syntax.raw) },
    "markup.link": { fg: RGBA.fromHex(colors.cyan) },
    "markup.link.label": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.link.url": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.quote": { fg: RGBA.fromHex(colors.dim), italic: true },
    "markup.list": { fg: RGBA.fromHex(colors.text) },
    keyword: { fg: kw, bold: true },
    "keyword.return": { fg: kw, bold: true },
    "keyword.function": { fg: kw, bold: true },
    "keyword.import": { fg: kw, bold: true },
    "keyword.operator": { fg: op },
    "keyword.conditional": { fg: kw, bold: true },
    "keyword.repeat": { fg: kw, bold: true },
    "keyword.exception": { fg: kw, bold: true },
    string: { fg: str },
    "string.special": { fg: str },
    "string.escape": { fg: num },
    comment: { fg: cmt, italic: true },
    "comment.line": { fg: cmt, italic: true },
    "comment.block": { fg: cmt, italic: true },
    function: { fg: fn },
    "function.call": { fg: fn },
    "function.method": { fg: fn },
    "function.builtin": { fg: fn },
    method: { fg: fn },
    variable: { fg: RGBA.fromHex(tokens.syntax.variable) },
    "variable.builtin": { fg: lit },
    "variable.parameter": { fg: RGBA.fromHex(tokens.syntax.variable) },
    type: { fg: typ },
    "type.builtin": { fg: typ },
    constructor: { fg: typ },
    number: { fg: num },
    "number.float": { fg: num },
    constant: { fg: lit },
    "constant.builtin": { fg: lit },
    boolean: { fg: lit },
    operator: { fg: op },
    punctuation: { fg: op },
    "punctuation.bracket": { fg: op },
    "punctuation.delimiter": { fg: op },
    "punctuation.special": { fg: op },
    property: { fg: RGBA.fromHex(tokens.syntax.variable) },
    attribute: { fg: typ },
    tag: { fg: kw },
    label: { fg: RGBA.fromHex(colors.accent) },
  });
}

/**
 * Build a fully-resolved DisplayTheme for a given mode. `overrides` is a
 * deep-partial token patch applied on top of the chosen mode's palette.
 *
 * `mode` is required: there is no canonical default theme. Callers must
 * resolve the mode first (FERMI_THEME env, settings, terminal OSC, picker).
 */
export function createDisplayTheme(mode: ThemeMode, overrides?: DeepPartial<DisplayThemeTokens>): DisplayTheme {
  const base = mode === "light" ? LIGHT_TOKENS : DARK_TOKENS;
  const tokens = mergeNested(base, overrides);
  return {
    mode,
    tokens,
    colors: tokens.colors,
    spacing: tokens.spacing,
    layout: tokens.layout,
    branding: tokens.branding,
    markdown: tokens.markdown,
    presentation: tokens.presentation,
    markdownStyle: buildMarkdownStyle(tokens.colors, tokens.markdown),
  };
}
