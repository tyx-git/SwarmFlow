/**
 * Shared syntax highlighting and styled-text utilities.
 *
 * Extracted from tool-result-artifacts.ts so that both the diff artifact
 * builder and the new FileModifyBody streaming component can reuse the
 * same language map, highlighting helpers, brightness constants, and
 * chunk manipulation functions.
 */

import { extname } from "node:path";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { displayWidthWithNewlines } from "../composer-token-logic.js";

// ------------------------------------------------------------------
// Language inference
// ------------------------------------------------------------------

// Extension → highlight.js language name.
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // A
  ".abnf": "abnf", ".ada": "ada", ".adb": "ada", ".adoc": "asciidoc",
  ".ado": "stata", ".ads": "ada", ".ahk": "autohotkey", ".aj": "aspectj",
  ".applescript": "applescript", ".arcade": "arcade", ".as": "actionscript",
  ".asciidoc": "asciidoc", ".asm": "x86asm", ".au3": "autoit", ".awk": "awk",
  // B
  ".bas": "basic", ".bash": "bash", ".bat": "dos", ".bf": "brainfuck",
  ".bnf": "bnf", ".bsl": "1c",
  // C
  ".c": "c", ".cal": "cal", ".capnp": "capnproto", ".cc": "cpp",
  ".ceylon": "ceylon", ".cfg": "ini", ".cjs": "javascript", ".clj": "clojure",
  ".cljc": "clojure", ".cljs": "clojure", ".cls": "latex", ".cmake": "cmake",
  ".cmd": "dos", ".coffee": "coffeescript", ".cos": "cos", ".cpp": "cpp",
  ".cr": "crystal", ".crm": "crmsh", ".cs": "csharp", ".css": "css",
  ".cts": "typescript", ".cxx": "cpp",
  // D
  ".d": "d", ".dart": "dart", ".dcl": "clean", ".diff": "diff",
  ".do": "stata", ".dockerfile": "dockerfile", ".dpr": "delphi",
  ".dts": "dts", ".dtsi": "dts", ".dust": "dust",
  // E
  ".ebnf": "ebnf", ".el": "lisp", ".elm": "elm", ".erb": "erb",
  ".erl": "erlang", ".ex": "elixir", ".exs": "elixir",
  // F
  ".f": "fortran", ".f03": "fortran", ".f08": "fortran", ".f90": "fortran",
  ".f95": "fortran", ".feature": "gherkin", ".flix": "flix", ".frag": "glsl",
  ".fs": "fsharp", ".fsi": "fsharp", ".fsx": "fsharp",
  // G
  ".gcode": "gcode", ".gemspec": "ruby", ".glsl": "glsl", ".gml": "gml",
  ".gms": "gams", ".go": "go", ".golo": "golo", ".gradle": "gradle",
  ".groovy": "groovy", ".gss": "gauss", ".gvy": "groovy",
  // H
  ".h": "c", ".haml": "haml", ".handlebars": "handlebars", ".hbs": "handlebars",
  ".hpp": "cpp", ".hrl": "erlang", ".hs": "haskell", ".hsp": "hsp",
  ".htaccess": "apache", ".htm": "xml", ".html": "xml", ".hx": "haxe",
  ".hxx": "cpp", ".hy": "hy",
  // I
  ".i7x": "inform7", ".icl": "clean", ".ini": "ini", ".ino": "arduino",
  // J
  ".java": "java", ".jl": "julia", ".js": "javascript", ".json": "json",
  ".jsx": "javascript",
  // K
  ".kt": "kotlin", ".kts": "kotlin",
  // L
  ".lasso": "lasso", ".ldif": "ldif", ".leaf": "leaf", ".less": "less",
  ".lhs": "haskell", ".lisp": "lisp", ".ll": "llvm", ".ls": "livescript",
  ".lsl": "lsl", ".lsp": "lisp", ".lua": "lua",
  // M
  ".m": "objectivec", ".mac": "maxima", ".markdown": "markdown", ".md": "markdown",
  ".mel": "mel", ".miz": "mizar", ".mjs": "javascript", ".mk": "makefile",
  ".ml": "ocaml", ".mli": "ocaml", ".mm": "objectivec", ".monkey": "monkey",
  ".moon": "moonscript", ".mts": "typescript",
  // N
  ".nb": "mathematica", ".nc": "gcode", ".ni": "inform7", ".nim": "nim",
  ".nix": "nix", ".nsh": "nsis", ".nsi": "nsis",
  // O
  ".os": "1c",
  // P
  ".pas": "delphi", ".patch": "diff", ".pb": "purebasic", ".pde": "processing",
  ".pf": "pf", ".php": "php", ".phtml": "php", ".pl": "perl",
  ".plist": "xml", ".pm": "perl", ".pony": "pony", ".pp": "puppet",
  ".pro": "prolog", ".properties": "properties", ".proto": "protobuf",
  ".ps1": "powershell", ".psd1": "powershell", ".psm1": "powershell",
  ".py": "python", ".pyw": "python",
  // Q
  ".q": "q", ".qml": "qml",
  // R
  ".r": "r", ".rake": "ruby", ".rb": "ruby", ".re": "reasonml",
  ".rei": "reasonml", ".rib": "rib", ".rs": "rust", ".rsc": "routeros",
  ".rsl": "rsl",
  // S
  ".sas": "sas", ".sc": "scala", ".scala": "scala", ".scad": "openscad",
  ".sci": "scilab", ".scm": "scheme", ".scpt": "applescript", ".scss": "scss",
  ".sh": "bash", ".smali": "smali", ".sml": "sml", ".sqf": "sqf",
  ".sql": "sql", ".ss": "scheme", ".st": "smalltalk", ".stan": "stan",
  ".step": "step21", ".stp": "step21", ".styl": "stylus", ".sv": "verilog",
  ".svg": "xml", ".swift": "swift", ".sty": "latex",
  // T
  ".tcl": "tcl", ".tex": "latex", ".thrift": "thrift", ".toml": "ini",
  ".ts": "typescript", ".tsx": "typescript", ".twig": "twig", ".txt": "plaintext",
  // V
  ".v": "verilog", ".vala": "vala", ".vb": "vbnet", ".vbs": "vbscript",
  ".vert": "glsl", ".vhd": "vhdl", ".vhdl": "vhdl", ".vim": "vim",
  // W
  ".wl": "mathematica", ".wsdl": "xml",
  // X
  ".xl": "xl", ".xml": "xml", ".xq": "xquery", ".xquery": "xquery",
  ".xqy": "xquery", ".xsd": "xml", ".xsl": "xml",
  // Y
  ".yaml": "yaml", ".yml": "yaml",
  // Z
  ".zep": "zephir", ".zsh": "bash",
};

/** Infer highlight.js language from a file path's extension. */
export function inferLanguageFromPath(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()];
}

// ------------------------------------------------------------------
// Brightness constants
// ------------------------------------------------------------------

export const DIFF_BRIGHTNESS_ADDITION = 1.30;
export const DIFF_BRIGHTNESS_DELETION = 1.30;
export const DIFF_BRIGHTNESS_CONTEXT = 0.45;

// ------------------------------------------------------------------
// Comment/meta color exemptions
// ------------------------------------------------------------------

export const COMMENT_EXEMPT_COLORS = [
  // highlight.js comment / meta
  RGBA.fromHex("#5a5565"),
  RGBA.fromHex("#636a76"),
  // Shiki theme comments
  RGBA.fromHex("#51597D"),  // tokyo-night
  RGBA.fromHex("#5A6673"),  // ayu-dark
  RGBA.fromHex("#6272A4"),  // dracula
  RGBA.fromHex("#6A9955"),  // dark-plus
];

export function isCommentColor(color: RGBA | undefined): boolean {
  if (!color) return false;
  return COMMENT_EXEMPT_COLORS.some((c) => c.equals(color));
}

// ------------------------------------------------------------------
// Chunk helpers
// ------------------------------------------------------------------

export function createChunk(
  text: string,
  options: { fg?: RGBA; bg?: RGBA; attributes?: number } = {},
): TextChunk {
  return {
    __isChunk: true,
    text,
    fg: options.fg,
    bg: options.bg,
    attributes: options.attributes,
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function adjustBrightness(color: RGBA | undefined, factor: number): RGBA | undefined {
  if (!color || factor === 1) return color;
  if (color.intent === "indexed") return color;
  if (factor >= 1) {
    // Gamma lift + saturation boost: brighten while preserving color distinction
    const gamma = 0.65;
    const sat = 1.6;
    const rg = Math.pow(color.r, gamma);
    const gg = Math.pow(color.g, gamma);
    const bg = Math.pow(color.b, gamma);
    const gray = (rg + gg + bg) / 3;
    return RGBA.fromValues(
      clamp01(gray + (rg - gray) * sat),
      clamp01(gray + (gg - gray) * sat),
      clamp01(gray + (bg - gray) * sat),
      color.a,
    );
  }
  return RGBA.fromValues(
    color.r * factor,
    color.g * factor,
    color.b * factor,
    color.a,
  );
}

export function cloneChunksWithBaseStyle(
  chunks: TextChunk[],
  options: { fallbackFg?: RGBA; brightness?: number },
): TextChunk[] {
  const b = options.brightness ?? 1;
  return chunks.map((chunk) => {
    const fg = chunk.fg ?? options.fallbackFg;
    return {
      ...chunk,
      fg: isCommentColor(chunk.fg) ? fg : adjustBrightness(fg, b),
      bg: undefined,
    };
  });
}

// ------------------------------------------------------------------
// Display width + line splitting
// ------------------------------------------------------------------

export function chunkDisplayWidth(text: string): number {
  return displayWidthWithNewlines(text);
}

export function splitChunksToWidth(
  chunks: TextChunk[],
  maxWidth: number,
): TextChunk[][] {
  if (maxWidth <= 0) return [chunks];

  const lines: TextChunk[][] = [[]];
  let lineWidth = 0;

  for (const chunk of chunks) {
    const source = chunk.text;
    if (!source) continue;

    let buffer = "";

    const flushBuffer = (): void => {
      if (!buffer) return;
      lines[lines.length - 1].push({ ...chunk, text: buffer });
      buffer = "";
    };

    for (const ch of source) {
      const chWidth = chunkDisplayWidth(ch);
      if (lineWidth > 0 && lineWidth + chWidth > maxWidth) {
        flushBuffer();
        lines.push([]);
        lineWidth = 0;
      }
      buffer += ch;
      lineWidth += chWidth;
    }

    flushBuffer();
  }

  if (lines.length === 0) return [[]];
  return lines;
}

// ------------------------------------------------------------------
// Artifact line types
// ------------------------------------------------------------------

export interface ToolResultLineArtifact {
  content: StyledText;
  rowBackgroundColor?: string;
}

export function wrapStandaloneChunks(
  chunks: TextChunk[],
  wrapWidth?: number,
  rowBackgroundColor?: string,
): ToolResultLineArtifact[] {
  if (!wrapWidth || wrapWidth <= 0) {
    return [{ content: new StyledText(chunks), rowBackgroundColor }];
  }
  return splitChunksToWidth(chunks, wrapWidth).map((line) => ({
    content: new StyledText(line.length > 0 ? line : [createChunk(" ")]),
    rowBackgroundColor,
  }));
}

export function buildWrappedArtifacts(
  options: {
    prefixChunks: TextChunk[];
    continuationPrefixChunks: TextChunk[];
    payloadChunks: TextChunk[];
    rowBackgroundColor?: string;
    wrapWidth?: number;
  },
): ToolResultLineArtifact[] {
  const prefixWidth = options.prefixChunks.reduce((sum, chunk) => sum + chunkDisplayWidth(chunk.text), 0);
  const continuationPrefixWidth = options.continuationPrefixChunks.reduce((sum, chunk) => sum + chunkDisplayWidth(chunk.text), 0);
  const availableFirstWidth = Math.max(1, (options.wrapWidth ?? 0) - prefixWidth);
  const availableContinuationWidth = Math.max(1, (options.wrapWidth ?? 0) - continuationPrefixWidth);

  if (!options.wrapWidth || options.wrapWidth <= 0) {
    return [{
      content: new StyledText([...options.prefixChunks, ...options.payloadChunks]),
      rowBackgroundColor: options.rowBackgroundColor,
    }];
  }

  const firstPayloadLine = splitChunksToWidth(options.payloadChunks, availableFirstWidth);
  if (firstPayloadLine.length === 0) {
    return [{
      content: new StyledText(options.prefixChunks),
      rowBackgroundColor: options.rowBackgroundColor,
    }];
  }

  const wrapped: ToolResultLineArtifact[] = [];
  wrapped.push({
    content: new StyledText([
      ...options.prefixChunks,
      ...(firstPayloadLine[0] ?? []),
    ]),
    rowBackgroundColor: options.rowBackgroundColor,
  });

  const carry = firstPayloadLine.slice(1);
  if (carry.length === 0) return wrapped;

  const flattenedCarry = carry.flatMap((line) => line);
  const continuationLines = splitChunksToWidth(flattenedCarry, availableContinuationWidth);
  for (const line of continuationLines) {
    wrapped.push({
      content: new StyledText([
        ...options.continuationPrefixChunks,
        ...line,
      ]),
      rowBackgroundColor: options.rowBackgroundColor,
    });
  }

  return wrapped;
}
