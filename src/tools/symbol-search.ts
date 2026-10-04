/**
 * 面向代码声明的符号搜索。
 *
 * 这里搜索的是声明位置，而不是普通文本调用位置。它覆盖常见的
 * TypeScript/JavaScript、Python、Bash、PowerShell、Rust、Go、Java、C#、
 * C/C++、Ruby、PHP、Kotlin 和 Swift 声明形式，并返回可直接交给
 * read_file 使用的文件路径和行号。
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ToolDef } from "../providers/base.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import { isExcludedDirName, isHiddenName, truncateLine } from "./shared.js";

export const SYMBOL_SEARCH_MAX_RESULTS = 200;
const SYMBOL_SEARCH_MAX_FILES = 5_000;
const SYMBOL_SEARCH_MAX_FILE_SIZE = 2 * 1024 * 1024;
const SYMBOL_SEARCH_MAX_DEPTH = 16;
const SYMBOL_SEARCH_MAX_PATTERN_LENGTH = 200;
const SYMBOL_SEARCH_LINE_MAX_CHARS = 1_000;

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "struct"
  | "trait"
  | "enum"
  | "any";

export interface SymbolSearchOptions {
  query: string;
  path: string;
  language?: string;
  kind: SymbolKind;
  include?: string;
  caseInsensitive: boolean;
  hidden: boolean;
  noIgnore: boolean;
  follow: boolean;
  maxResults: number;
  signal?: AbortSignal;
}

export const FIND_SYMBOL: ToolDef = {
  name: "find_symbol",
  description:
    "Find code declarations by exact symbol name instead of matching every call site. " +
    "Returns absolute file paths, line/column, declaration kind, and the source signature. " +
    "Supports TypeScript/JavaScript, Python, Bash, PowerShell, Rust, Go, Java, C#, C/C++, Ruby, PHP, Kotlin, and Swift. " +
    "Use this before read_file when you need the implementation of a function, method, class, interface, type, or variable.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Exact symbol name. Use '*' or an empty value to list declarations of the selected kind.",
      },
      path: {
        type: "string",
        description: "File or directory to search (default: current project directory).",
        default: ".",
      },
      language: {
        type: "string",
        description: "Optional language filter (ts, js, py, bash, ps, rust, go, java, csharp, c, cpp, ruby, php, kotlin, swift).",
      },
      kind: {
        type: "string",
        enum: ["function", "method", "class", "interface", "type", "variable", "struct", "trait", "enum", "any"],
        description: "Declaration kind to return (default: function).",
        default: "function",
      },
      include: {
        type: "string",
        description: "Optional filename glob, for example **/*.{ts,tsx} or *.py.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Match symbol names case-insensitively. Default false.",
      },
      hidden: {
        type: "boolean",
        description: "Include hidden files and directories. Default false.",
      },
      no_ignore: {
        type: "boolean",
        description: "Do not skip the standard build/cache directories. Default false.",
      },
      follow: {
        type: "boolean",
        description: "Traverse symbolic-link directories. Default false.",
      },
      max_results: {
        type: "integer",
        description: `Maximum declarations to return (default ${SYMBOL_SEARCH_MAX_RESULTS}, cap ${SYMBOL_SEARCH_MAX_RESULTS}).`,
      },
    },
    required: ["query"],
  },
  summaryTemplate: "{agent} is locating symbol {query}",
  tuiPolicy: { partialReveal: { completeArgs: ["query"] } },
};

interface DeclarationMatch {
  name: string;
  kind: Exclude<SymbolKind, "any">;
  line: number;
  column: number;
  signature: string;
}

interface LanguageSpec {
  id: string;
  extensions: ReadonlySet<string>;
  declarations: ReadonlyArray<{
    kind: Exclude<SymbolKind, "any">;
    pattern: RegExp;
    nameGroup: number;
  }>;
}

const JS_DECLARATIONS = [
  { kind: "class" as const, pattern: /^\s*(?:(?:export|declare|abstract|default)\s+)*class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { kind: "interface" as const, pattern: /^\s*(?:(?:export|declare|default)\s+)*interface\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { kind: "type" as const, pattern: /^\s*(?:(?:export|declare|default)\s+)*type\s+([A-Za-z_$][\w$]*)\s*=/, nameGroup: 1 },
  { kind: "function" as const, pattern: /^\s*(?:(?:export|declare|default)\s+)*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, nameGroup: 1 },
  { kind: "variable" as const, pattern: /^\s*(?:(?:export|declare|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^\n]*\)|[A-Za-z_$][\w$]*)\s*=>/, nameGroup: 1 },
  { kind: "variable" as const, pattern: /^\s*(?:(?:export|declare|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, nameGroup: 1 },
  { kind: "method" as const, pattern: /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^\n]*\)\s*(?::[^={]+)?\s*\{/, nameGroup: 1 },
] as const;

const LANGUAGE_SPECS: readonly LanguageSpec[] = [
  {
    id: "javascript",
    extensions: new Set([".js", ".jsx", ".mjs", ".cjs"]),
    declarations: JS_DECLARATIONS,
  },
  {
    id: "typescript",
    extensions: new Set([".ts", ".tsx", ".mts", ".cts"]),
    declarations: JS_DECLARATIONS,
  },
  {
    id: "python",
    extensions: new Set([".py", ".pyi"]),
    declarations: [
      { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
    ],
  },
  {
    id: "bash",
    extensions: new Set([".sh", ".bash", ".zsh", ".fish"]),
    declarations: [
      { kind: "function", pattern: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*(?:\{|$)/, nameGroup: 1 },
    ],
  },
  {
    id: "powershell",
    extensions: new Set([".ps1", ".psm1", ".psd1"]),
    declarations: [
      { kind: "function", pattern: /^\s*function\s+([A-Za-z_][\w-]*)\b/, nameGroup: 1 },
    ],
  },
  {
    id: "rust",
    extensions: new Set([".rs"]),
    declarations: [
      { kind: "function", pattern: /^\s*(?:(?:pub(?:\([^)]*\))?|const|unsafe|async|extern)\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/, nameGroup: 1 },
      { kind: "struct", pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "type", pattern: /^\s*(?:pub\s+)?type\s+([A-Za-z_]\w*)\s*=/, nameGroup: 1 },
      { kind: "trait", pattern: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
    ],
  },
  {
    id: "go",
    extensions: new Set([".go"]),
    declarations: [
      { kind: "function", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
      { kind: "type", pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|[A-Za-z_*\[\]])/, nameGroup: 1 },
    ],
  },
  {
    id: "java",
    extensions: new Set([".java"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:public|private|protected|abstract|final|static)\s+)*class\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "interface", pattern: /^\s*(?:(?:public|private|protected|abstract)\s+)*interface\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native)\s+)*(?:[\w<>?,.\[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws\s+[^\{]+)?\s*\{/, nameGroup: 1 },
    ],
  },
  {
    id: "csharp",
    extensions: new Set([".cs"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*class\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "interface", pattern: /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|new)\s+)*(?:[\w<>?,.\[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|=>)/, nameGroup: 1 },
    ],
  },
  {
    id: "c",
    extensions: new Set([".c", ".h"]),
    declarations: [
      { kind: "function", pattern: /^\s*(?:(?:static|inline|extern|unsigned|signed|const|volatile|struct\s+\w+|enum\s+\w+|[A-Za-z_]\w*)\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/, nameGroup: 1 },
      { kind: "class", pattern: /^\s*typedef\s+struct\s+([A-Za-z_]\w*)?\s*\{/, nameGroup: 1 },
    ],
  },
  {
    id: "cpp",
    extensions: new Set([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:template\s*<[^>]*>\s*)?)(?:class|struct)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:(?:static|inline|virtual|constexpr|const|unsigned|signed|long|short|auto|[A-Za-z_]\w*(?:<[^>]*>)?)\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/, nameGroup: 1 },
    ],
  },
  {
    id: "ruby",
    extensions: new Set([".rb"]),
    declarations: [
      { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*def\s+([A-Za-z_]\w*[!?=]?)/, nameGroup: 1 },
    ],
  },
  {
    id: "php",
    extensions: new Set([".php", ".phtml"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:abstract|final)\s+)?class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:public|private|protected|static|final|abstract\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
    ],
  },
  {
    id: "kotlin",
    extensions: new Set([".kt", ".kts"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:public|private|internal|protected|data|sealed|open|abstract)\s+)*class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:(?:public|private|internal|protected|suspend|inline|override)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
    ],
  },
  {
    id: "swift",
    extensions: new Set([".swift"]),
    declarations: [
      { kind: "class", pattern: /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum)\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: "function", pattern: /^\s*(?:(?:public|private|internal|open|static|class|mutating|override)\s+)*func\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
    ],
  },
];

const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["py", "python"], ["ps", "powershell"], ["ps1", "powershell"], ["sh", "bash"], ["shell", "bash"],
  ["rs", "rust"], ["cs", "csharp"], ["c++", "cpp"],
]);

function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
}

function languageForFile(filePath: string): LanguageSpec | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_SPECS.find((spec) => spec.extensions.has(ext));
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close > i) {
        const choices = pattern.slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        source += `(?:${choices})`;
        i = close;
      } else {
        source += "\\{";
      }
    } else {
      source += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`${source}$`);
}

function matchesInclude(filePath: string, include: string | undefined, basePath?: string): boolean {
  if (!include) return true;
  const normalized = include.replace(/\\/g, "/");
  const relative = (basePath ? path.relative(basePath, filePath) : filePath).replace(/\\/g, "/");
  const base = path.basename(relative);
  const pattern = normalized.includes("/") ? normalized : `**/${normalized}`;
  return globToRegex(pattern).test(relative) || globToRegex(normalized).test(base);
}

function symbolMatches(name: string, query: string, caseInsensitive: boolean): boolean {
  const q = query.trim();
  if (!q || q === "*") return true;
  return caseInsensitive ? name.toLocaleLowerCase() === q.toLocaleLowerCase() : name === q;
}

function parseDeclarations(
  text: string,
  spec: LanguageSpec,
  query: string,
  kind: SymbolKind,
  caseInsensitive: boolean,
): DeclarationMatch[] {
  const matches: DeclarationMatch[] = [];
  const controlWords = new Set(["if", "for", "while", "switch", "catch", "with"]);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const declaration of spec.declarations) {
      if (kind !== "any" && declaration.kind !== kind) continue;
      const match = declaration.pattern.exec(line);
      if (!match) continue;
      const name = match[declaration.nameGroup];
      if (!name || !symbolMatches(name, query, caseInsensitive)) continue;
      if (declaration.kind === "method" && controlWords.has(name)) continue;
      const column = Math.max(1, (match.index ?? 0) + line.slice(match.index ?? 0).indexOf(name) + 1);
      matches.push({
        name,
        kind: declaration.kind,
        line: index + 1,
        column,
        signature: truncateLine(line.trim(), SYMBOL_SEARCH_LINE_MAX_CHARS),
      });
      break;
    }
  }
  return matches;
}

async function collectFiles(
  root: string,
  options: SymbolSearchOptions,
): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const rootStat = await fs.stat(root);
  if (rootStat.isFile()) return [root];

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= SYMBOL_SEARCH_MAX_FILES || depth > SYMBOL_SEARCH_MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= SYMBOL_SEARCH_MAX_FILES) return;
      if (!options.hidden && isHiddenName(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = options.follow ? await fs.stat(full) : await fs.lstat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!options.noIgnore && isExcludedDirName(name)) continue;
        if (!options.follow && stat.isSymbolicLink()) continue;
        const real = options.follow ? await fs.realpath(full).catch(() => full) : full;
        if (seen.has(real)) continue;
        seen.add(real);
        await walk(full, depth + 1);
      } else if (stat.isFile() && stat.size <= SYMBOL_SEARCH_MAX_FILE_SIZE) {
        if (getSensitiveFileReadReason(full)) continue;
        if (!options.noIgnore && isExcludedDirName(path.basename(path.dirname(full)))) continue;
        if (options.include && !matchesInclude(full, options.include, root)) continue;
        if (options.language) {
          const spec = languageForFile(full);
          if (!spec || spec.id !== normalizeLanguage(options.language)) continue;
        }
        files.push(full);
      }
    }
  }

  await walk(root, 0);
  return files;
}

export async function toolFindSymbol(
  options: SymbolSearchOptions,
): Promise<string> {
  const query = options.query.trim();
  if (query.length > SYMBOL_SEARCH_MAX_PATTERN_LENGTH) {
    return `ERROR: find_symbol query exceeds max length (${query.length} chars, limit ${SYMBOL_SEARCH_MAX_PATTERN_LENGTH}).`;
  }
  if (!existsSync(options.path)) return `ERROR: Path not found: ${options.path}`;
  const files = await collectFiles(options.path, options);
  const output: string[] = [];
  for (const filePath of files) {
    if (options.signal?.aborted) return "ERROR: Symbol search was cancelled.";
    if (output.length >= options.maxResults) break;
    if (getSensitiveFileReadReason(filePath)) continue;
    try {
      if ((await fs.stat(filePath)).size > SYMBOL_SEARCH_MAX_FILE_SIZE) continue;
    } catch {
      continue;
    }
    const spec = languageForFile(filePath);
    if (!spec) continue;
    if (options.language && spec.id !== normalizeLanguage(options.language)) continue;
    if (options.include && !matchesInclude(filePath, options.include, options.path)) continue;
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const declarations = parseDeclarations(text, spec, query, options.kind, options.caseInsensitive);
    for (const declaration of declarations) {
      if (options.signal?.aborted) return "ERROR: Symbol search was cancelled.";
      if (output.length >= options.maxResults) break;
      output.push(`${filePath}:${declaration.line}:${declaration.column}: ${declaration.kind} ${declaration.name}  ${declaration.signature}`);
    }
  }
  if (output.length === 0) return "No symbols found.";
  let result = output.join("\n");
  if (output.length >= options.maxResults) {
    result += `\n\n[Results capped at ${options.maxResults}. Narrow query/path/include or raise max_results.]`;
  }
  return result;
}
