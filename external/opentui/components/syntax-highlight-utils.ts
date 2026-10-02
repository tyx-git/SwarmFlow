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
import { getUiCommonColors } from "../../../src/config/ui-colors.js";
import { highlightToChunks } from "../forked/patch-opentui-markdown.js";
import { inferCodeFiletype } from "../forked/core/lib/tree-sitter/resolve-ft.js";

const COMMENT_EXEMPT_COLOR_VALUES = getUiCommonColors().syntaxCommentExempt;

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

// ripgrep/编译器常见的 `path:line[:column]:source` 输出；扩展名由语言表另行判断。
const SOURCE_RESULT_RE = /^(.+?):(\d+)(?::(\d+))?:(.*)$/;

export type SyntaxTextMode = "command" | "output";

function stripCommandPrompt(line: string): string {
  return line.replace(/^(?:❯\s*|>\s*|PS(?:\s+[^>]+)?>\s*)/i, "");
}

function splitCommandPrompt(line: string): { prompt: string; command: string } {
  const match = line.match(/^(\s*(?:❯\s*|>\s*|PS(?:\s+[^>]+)?>\s*))/i);
  if (!match) return { prompt: "", command: line };
  return { prompt: match[1], command: line.slice(match[1].length) };
}

function styledChunksForLanguage(text: string, language: string, fallbackFg?: RGBA): TextChunk[] {
  const highlighted = highlightToChunks(text, language);
  if (!highlighted || highlighted.length === 0) {
    return [createChunk(text || " ", { fg: fallbackFg })];
  }
  return highlighted.map((chunk) => ({ ...chunk, fg: chunk.fg ?? fallbackFg }));
}

function highlightCommandLines(
  text: string,
  language: string,
  fallbackFg?: RGBA,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const { prompt, command } = splitCommandPrompt(line);
    const leading = command.match(/^\s*/)?.[0] ?? "";
    const commandMatch = command.slice(leading.length).match(/^([^\s|;&]+)(.*)$/);
    if (commandMatch) {
      if (prompt) chunks.push(createChunk(prompt, { fg: fallbackFg }));
      chunks.push(createChunk(leading, { fg: fallbackFg }));
      chunks.push(...styledChunksForLanguage(`${commandMatch[1]}${commandMatch[2]}`, language, fallbackFg));
    } else {
      chunks.push(createChunk(line || " ", { fg: fallbackFg }));
    }
    if (index < lines.length - 1) chunks.push(createChunk("\n", { fg: fallbackFg }));
  });
  return chunks;
}

/**
 * 高亮 shell 命令和 ripgrep 风格源码输出，同时保持普通日志为纯文本。
 * `src/a.ts:12:const x` 会分别高亮路径、行号和源码片段。
 */
export function buildCommandStyledText(
  text: string,
  options: {
    mode: SyntaxTextMode;
    language?: string;
    fallbackFg?: RGBA;
    pathFg?: RGBA;
    lineFg?: RGBA;
    metadataFg?: RGBA;
  },
): StyledText {
  const lines = text.split("\n");
  const chunks: TextChunk[] = [];
  const fallbackFg = options.fallbackFg;
  const pathFg = options.pathFg ?? fallbackFg;
  const lineFg = options.lineFg ?? fallbackFg;
  const metadataFg = options.metadataFg ?? fallbackFg;

  lines.forEach((line, index) => {
    const sourceMatch = line.match(SOURCE_RESULT_RE);
    const sourcePath = sourceMatch?.[1] ?? "";
    const isSourceResult = Boolean(
      sourceMatch
      && (inferLanguageFromPath(sourcePath) !== undefined || /[\\/]/.test(sourcePath)),
    );
    if (sourceMatch && isSourceResult) {
      const [, filePath, lineNumber, columnNumber, source] = sourceMatch;
      chunks.push(createChunk(filePath, { fg: pathFg }));
      chunks.push(createChunk(`:${lineNumber}${columnNumber ? `:${columnNumber}` : ""}:`, { fg: lineFg }));
      const language = inferLanguageFromPath(filePath) ?? options.language;
      if (language) chunks.push(...styledChunksForLanguage(source, language, fallbackFg));
      else chunks.push(createChunk(source || " ", { fg: fallbackFg }));
    } else {
      const commandLine = stripCommandPrompt(line.trimStart());
      const language = options.language ?? inferCodeFiletype(commandLine);
      const shouldHighlight = options.mode === "command"
        ? inferCodeFiletype(commandLine) !== undefined
        : options.language !== undefined || inferCodeFiletype(commandLine) !== undefined;
      if (shouldHighlight && language) {
        chunks.push(...(options.mode === "command"
          ? highlightCommandLines(line, language, fallbackFg)
          : styledChunksForLanguage(line, language, fallbackFg)));
      } else {
        chunks.push(createChunk(line || " ", { fg: fallbackFg }));
      }
    }
    if (index < lines.length - 1) chunks.push(createChunk("\n", { fg: metadataFg }));
  });

  return new StyledText(chunks);
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

export const COMMENT_EXEMPT_COLORS = COMMENT_EXEMPT_COLOR_VALUES.map((color) => RGBA.fromHex(color));

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
