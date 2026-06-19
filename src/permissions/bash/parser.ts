/**
 * 基于 tree-sitter 的 shell 命令解析器。
 *
 * 支持 bash 和 PowerShell 语法。将命令解析为用于权限分类的结构化段。
 * 不支持的语法结构会被明确标记 — 分类器可以将它们升级为 "ask"。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Language, Parser, type Node as TreeNode } from "web-tree-sitter";
import type {
  BashConnector,
  BashParseResult,
  BashToken,
  BashTokenKind,
  BashUnsupportedReason,
  ParsedBashCommand,
  ParsedBashSegment,
  UnsupportedBashScript,
} from "./types.js";

const require = createRequire(import.meta.url);

/** 默认解析超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 50;

// ------------------------------------------------------------------
// WASM 路径解析
// ------------------------------------------------------------------

function isCompiledBinary(): boolean {
  return import.meta.dirname.includes("$bunfs") || /^B:[\\/]~BUN/i.test(import.meta.dirname);
}

function resolveWebTreeSitterWasmPath(): string {
  if (isCompiledBinary()) {
    const p = join(dirname(process.execPath), "bash-parser", "tree-sitter.wasm");
    if (existsSync(p)) return p;
  }
  return require.resolve("web-tree-sitter/tree-sitter.wasm");
}

function resolveTreeSitterBashWasmPath(): string {
  if (isCompiledBinary()) {
    const p = join(dirname(process.execPath), "bash-parser", "tree-sitter-bash.wasm");
    if (existsSync(p)) return p;
  }
  return join(dirname(require.resolve("tree-sitter-bash/package.json")), "tree-sitter-bash.wasm");
}

function resolveTreeSitterPowerShellWasmPath(): string {
  if (isCompiledBinary()) {
    const p = join(dirname(process.execPath), "bash-parser", "tree-sitter-powershell.wasm");
    if (existsSync(p)) return p;
  }
  return join(dirname(require.resolve("tree-sitter-powershell/package.json")), "tree-sitter-powershell.wasm");
}

// ------------------------------------------------------------------
// 单例解析器初始化 — 加载 bash 和 PowerShell
// ------------------------------------------------------------------

// Bash 解析器 — 始终加载（所有平台使用）
let bashParserInit: Promise<Parser> | null = null;
let parserRuntimeReady = false;

/** 确保解析器运行时已初始化 */
async function ensureParserRuntime(): Promise<void> {
  if (parserRuntimeReady) return;
  await Parser.init({
    locateFile() {
      return resolveWebTreeSitterWasmPath();
    },
  });
  parserRuntimeReady = true;
}

async function initializeBashParser(): Promise<Parser> {
  await ensureParserRuntime();
  const lang = await Language.load(resolveTreeSitterBashWasmPath());
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

/** 获取解析器实例 */
export async function getParser(): Promise<Parser> {
  if (!bashParserInit) bashParserInit = initializeBashParser();
  return bashParserInit;
}

// PowerShell 解析器 — 仅在 shellKind 为 pwsh/powershell 时延迟加载，
// 这样 macOS/Linux 上缺少 WASM 文件不会降级 bash 分类器
let psParserInit: Promise<Parser> | null = null;

async function initializePSParser(): Promise<Parser> {
  await ensureParserRuntime();
  const lang = await Language.load(resolveTreeSitterPowerShellWasmPath());
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

async function getPSParser(): Promise<Parser> {
  if (!psParserInit) psParserInit = initializePSParser();
  return psParserInit;
}

/**
 * 将 bash 命令字符串解析为结构化段。
 */
export async function parseBashCommand(
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BashParseResult> {
  const parser = await getParser();
  const startedAt = performance.now();
  const tree = parser.parse(command);
  if (tree === null) {
    return unsupported("parse_error", "Shell parsing failed and requires manual approval.");
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > timeoutMs) {
    return unsupported("timeout", "Shell parsing took too long and requires manual approval.");
  }
  if (tree.rootNode.hasError) {
    return unsupported("parse_error", "Shell parsing failed and requires manual approval.");
  }

  const segments: ParsedBashSegment[] = [];
  const state = { connectorBefore: null as BashConnector | null };
  const walked = walkNode(tree.rootNode, state, segments);
  if (walked !== undefined) {
    return walked;
  }

  return { kind: "ok", segments };
}

// ------------------------------------------------------------------
// AST 遍历
// ------------------------------------------------------------------

/**
 * 遍历 AST 节点，构建段列表。
 */
function walkNode(
  node: TreeNode,
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  switch (node.type) {
    case "program":
    case "list":
      return walkSequential(node, state, segments);
    case "command":
      return appendCommandSegment(node, "command", state, segments);
    case "pipeline":
      return appendCommandSegment(node, "pipeline", state, segments);
    case "redirected_statement":
      return handleRedirectedStatement(node, state, segments);
    case "file_redirect":
      // 独立的 file_redirect 在 redirected_statement 之外 — 安全忽略
      return;
    case "heredoc_redirect":
    case "heredoc_start":
    case "heredoc_body":
    case "heredoc_end":
      return unsupported("heredoc", "Shell heredoc syntax requires manual approval.", node);
    case "subshell":
      return unsupported("subshell", "Shell subshell syntax requires manual approval.", node);
    case "process_substitution":
      return unsupported("process_substitution", "Shell process substitution requires manual approval.", node);
    case "command_substitution":
      return unsupported(
        node.text.startsWith("`") ? "backticks" : "command_substitution",
        "Shell command substitution requires manual approval.",
        node,
      );
    case "variable_assignment":
      // 独立的变量赋值（如 `FOO=bar`）在子进程中是空操作 — 跳过
      return;
    default:
      if (node.isNamed) {
        return unsupported("unsupported_node", `Unsupported shell node: ${node.type}`, node);
      }
      return;
  }
}

/**
 * 顺序遍历节点列表。
 */
function walkSequential(
  node: TreeNode,
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed) {
      const connector = parseConnector(child.type);
      if (connector) state.connectorBefore = connector;
      continue;
    }
    const result = walkNode(child, state, segments);
    if (result) return result;
  }
}

/**
 * 追加命令段。
 */
function appendCommandSegment(
  node: TreeNode,
  operator: "command" | "pipeline",
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  const commands: ParsedBashCommand[] = [];
  if (operator === "command") {
    const command = tokenizeCommandNode(node);
    if (isUnsupported(command)) return command;
    commands.push(command);
  } else {
    for (const child of namedChildren(node)) {
      const command = tokenizeCommandNode(child);
      if (isUnsupported(command)) return command;
      commands.push(command);
    }
  }

  segments.push({
    index: segments.length,
    text: node.text,
    operator,
    connectorBefore: state.connectorBefore,
    commands,
  });
  state.connectorBefore = null;
}

/**
 * 处理 `redirected_statement`：展开内部命令/管道/列表，
 * 并检查重定向是否写入真实文件（vs /dev/null 或 fd dup）。
 *
 * 当内部是 `list`（如 `cd x && npm install 2>&1`）时，递归遍历，
 * 使 `&&` / `||` / `;` 链展开为每个命令的段；否则
 * 尾部重定向会强制整个复合语句进入不支持的路径并禁用记忆化。
 */
function handleRedirectedStatement(
  node: TreeNode,
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  let innerNode: TreeNode | null = null;
  let hasFileWrite = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "command" || child.type === "pipeline" || child.type === "list") {
      innerNode = child;
    } else if (child.type === "file_redirect" || child.type === "heredoc_redirect") {
      if (child.type === "heredoc_redirect") {
        return unsupported("heredoc", "Shell heredoc syntax requires manual approval.", child);
      }
      // 确定此重定向是否写入真实文件
      const redirectTarget = getRedirectTarget(child);
      if (redirectTarget && redirectTarget !== "/dev/null") {
        hasFileWrite = true;
      }
    }
  }

  if (!innerNode) {
    return unsupported("unsupported_node", "Redirected statement has no inner command.", node);
  }

  // 复合内部（`cmd1 && cmd2 > out`）：遍历列表，使每个命令成为自己的段，
  // 然后将文件写标志附加到最后一段（bash 将尾部重定向绑定到最后命令）。
  if (innerNode.type === "list") {
    const startIdx = segments.length;
    const result = walkSequential(innerNode, state, segments);
    if (result) return result;
    if (hasFileWrite && segments.length > startIdx) {
      const last = segments[segments.length - 1]!;
      segments[segments.length - 1] = { ...last, hasFileWriteRedirect: true };
    }
    return;
  }

  const operator = innerNode.type === "pipeline" ? "pipeline" as const : "command" as const;
  const commands: ParsedBashCommand[] = [];
  if (operator === "command") {
    const command = tokenizeCommandNode(innerNode);
    if (isUnsupported(command)) return command;
    commands.push(command);
  } else {
    for (const child of namedChildren(innerNode)) {
      const command = tokenizeCommandNode(child);
      if (isUnsupported(command)) return command;
      commands.push(command);
    }
  }

  segments.push({
    index: segments.length,
    text: node.text,
    operator,
    connectorBefore: state.connectorBefore,
    commands,
    hasFileWriteRedirect: hasFileWrite || undefined,
  });
  state.connectorBefore = null;
}

/**
 * 获取重定向目标路径。
 */
function getRedirectTarget(fileRedirectNode: TreeNode): string | null {
  for (let i = 0; i < fileRedirectNode.childCount; i++) {
    const child = fileRedirectNode.child(i);
    if (!child) continue;
    // 目标通常是操作符（>, >>, 2>）后的 "word" 节点
    if (child.type === "word" || child.type === "string" || child.type === "raw_string") {
      return child.text.replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// ------------------------------------------------------------------
// 命令标记化
// ------------------------------------------------------------------

/**
 * 将命令节点标记化。
 */
function tokenizeCommandNode(node: TreeNode): ParsedBashCommand | UnsupportedBashScript {
  const tokens: BashToken[] = [];
  let nameToken: BashToken | null = null;

  for (const child of namedChildren(node)) {
    // 命令前的 VAR=val 前缀 — 跳过，对真实命令进行分类
    if (child.type === "variable_assignment") continue;

    const forbidden = findForbiddenNode(child);
    if (forbidden) return forbidden;

    if (child.type === "command_name") {
      nameToken = tokenizeNode(firstNamedChild(child) ?? child);
      continue;
    }

    tokens.push(tokenizeNode(child));
  }

  if (nameToken === null) {
    return unsupported("unsupported_node", "Shell command is missing a command name.", node);
  }

  return { text: node.text, name: nameToken.value, nameToken, argv: tokens };
}

/**
 * 将节点标记化。
 */
function tokenizeNode(node: TreeNode): BashToken {
  switch (node.type) {
    case "word":
      return { text: node.text, value: node.text, kind: "literal", quoted: false };
    case "raw_string":
      return { text: node.text, value: node.text.slice(1, -1), kind: "literal", quoted: true };
    case "string":
      return tokenizeString(node);
    case "simple_expansion":
    case "expansion":
      return tokenizeExpansion(node);
    case "concatenation":
      return tokenizeConcatenation(node);
    default:
      return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: false };
  }
}

/**
 * 标记化字符串节点。
 */
function tokenizeString(node: TreeNode): BashToken {
  const named = namedChildren(node);
  if (named.some((child) => child.type !== "string_content")) {
    return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: true };
  }
  return {
    text: node.text,
    value: named.map((child) => child.text).join(""),
    kind: "literal",
    quoted: true,
  };
}

/**
 * 标记化展开节点。
 */
function tokenizeExpansion(node: TreeNode): BashToken {
  const isHome = node.text === "$HOME" || node.text === "${HOME}";
  return {
    text: node.text,
    value: node.text,
    kind: isHome ? "home_reference" : "unresolved_expression",
    quoted: false,
  };
}

/**
 * 标记化连接节点。
 */
function tokenizeConcatenation(node: TreeNode): BashToken {
  const parts = namedChildren(node).map(tokenizeNode);
  const unresolved = parts.some((p) => p.kind === "unresolved_expression");
  if (unresolved) {
    return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: parts.some((p) => p.quoted) };
  }
  return {
    text: node.text,
    value: parts.map((p) => p.value).join(""),
    kind: parts.some((p) => p.kind === "home_reference") ? "home_reference" : "literal",
    quoted: parts.some((p) => p.quoted),
  };
}

// ------------------------------------------------------------------
// 禁止节点检测
// ------------------------------------------------------------------

/**
 * 查找禁止的节点。
 */
function findForbiddenNode(node: TreeNode): UnsupportedBashScript | null {
  switch (node.type) {
    case "command_substitution":
      return unsupported(
        node.text.startsWith("`") ? "backticks" : "command_substitution",
        "Shell command substitution requires manual approval.",
        node,
      );
    case "process_substitution":
      return unsupported("process_substitution", "Shell process substitution requires manual approval.", node);
    case "heredoc_redirect":
    case "heredoc_start":
    case "heredoc_body":
    case "heredoc_end":
      return unsupported("heredoc", "Shell heredoc syntax requires manual approval.", node);
    case "subshell":
      return unsupported("subshell", "Shell subshell syntax requires manual approval.", node);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const forbidden = findForbiddenNode(child);
      if (forbidden) return forbidden;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

function parseConnector(type: string): BashConnector | null {
  if (type === "&&" || type === "||" || type === ";" || type === "|") return type;
  return null;
}

function unsupported(
  reason: BashUnsupportedReason,
  message: string,
  node?: TreeNode,
  text?: string,
): UnsupportedBashScript {
  return { kind: "unsupported", reason, message, nodeType: node?.type, text: text ?? node?.text };
}

function isUnsupported(value: ParsedBashCommand | UnsupportedBashScript): value is UnsupportedBashScript {
  return "kind" in value && value.kind === "unsupported";
}

function firstNamedChild(node: TreeNode): TreeNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) return child;
  }
  return null;
}

function namedChildren(node: TreeNode): TreeNode[] {
  const children: TreeNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) children.push(child);
  }
  return children;
}

// ------------------------------------------------------------------
// PowerShell 解析器
// ------------------------------------------------------------------

/**
 * 将 PowerShell 命令字符串解析为结构化段。
 *
 * 使用 tree-sitter-powershell 进行 AST 精确解析。输出
 * 重用相同的 BashParseResult / ParsedBashCommand 类型，
 * 使分类器可以统一处理两种 shell 类型。
 *
 * AST 结构（tree-sitter-powershell）：
 *   program → statement_list → pipeline → pipeline_chain → command
 *   管道链（&&/||）拆分为多个 pipeline_chain 节点。
 *   命令参数位于 `command_elements` 容器下。
 *   重定向出现在 command_elements 内部的 `redirection` 节点中。
 */
export async function parsePowerShellCommand(
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BashParseResult> {
  const parser = await getPSParser();
  const startedAt = performance.now();
  const tree = parser.parse(command);
  if (tree === null) {
    return unsupported("parse_error", "PowerShell parsing failed and requires manual approval.");
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > timeoutMs) {
    return unsupported("timeout", "PowerShell parsing took too long and requires manual approval.");
  }
  if (tree.rootNode.hasError) {
    return unsupported("parse_error", "PowerShell parsing failed and requires manual approval.");
  }

  const segments: ParsedBashSegment[] = [];
  walkPSNode(tree.rootNode, segments);

  // 安全保护：如果非空输入产生零段，
  // AST 包含我们无法识别的结构 — 升级为不支持
  if (segments.length === 0 && command.trim().length > 0) {
    return unsupported("unsupported_node", "PowerShell command structure not recognized; requires manual approval.");
  }

  return { kind: "ok", segments };
}

// 遍历 PowerShell AST 自顶向下，收集命令段
function walkPSNode(
  node: TreeNode,
  segments: ParsedBashSegment[],
): void {
  switch (node.type) {
    case "program":
    case "statement_list":
    case "named_block":
    case "named_block_list":
    case "statement_block":
    case "if_statement":
    case "while_statement":
    case "for_statement":
    case "foreach_statement":
    case "do_statement":
    case "switch_statement":
    case "try_statement":
    case "trap_statement":
      for (const child of namedChildren(node)) {
        walkPSNode(child, segments);
      }
      return;

    case "pipeline": {
      // 管道包含一个或多个 pipeline_chain 节点
      // 每个 pipeline_chain 可能包含管道命令（cmd | cmd）
      // 多个 pipeline_chains 由 pipeline_chain_tail（&&/||）链接
      for (const child of namedChildren(node)) {
        walkPSNode(child, segments);
      }
      return;
    }

    case "pipeline_chain": {
      // 收集此链中的所有命令（可能有管道：cmd | cmd）
      const commands: ParsedBashCommand[] = [];
      let hasFileWrite = false;
      for (const child of namedChildren(node)) {
        if (child.type === "command" || child.type === "command_expression") {
          const result = tokenizePSCommand(child);
          if (result) {
            commands.push(result.cmd);
            if (result.hasRedirect) hasFileWrite = true;
          }
        }
      }
      if (commands.length > 0) {
        segments.push({
          index: segments.length,
          text: node.text,
          operator: commands.length > 1 ? "pipeline" : "command",
          connectorBefore: null,
          commands,
          hasFileWriteRedirect: hasFileWrite || undefined,
        });
      }
      return;
    }

    case "command":
    case "command_expression": {
      const result = tokenizePSCommand(node);
      if (result) {
        segments.push({
          index: segments.length,
          text: node.text,
          operator: "command",
          connectorBefore: null,
          commands: [result.cmd],
          hasFileWriteRedirect: result.hasRedirect || undefined,
        });
      }
      return;
    }

    // 跳过这些结构节点
    case "pipeline_chain_tail":
    case "empty_statement":
      return;

    default:
      // 递归到任何可能包含命令的无法识别的容器
      if (node.namedChildCount > 0) {
        for (const child of namedChildren(node)) {
          walkPSNode(child, segments);
        }
      }
      return;
  }
}

interface PSTokenizeResult {
  cmd: ParsedBashCommand;
  hasRedirect: boolean;
}

/**
 * 标记化 PowerShell 命令。
 */
function tokenizePSCommand(node: TreeNode): PSTokenizeResult | null {
  let nameToken: BashToken | null = null;
  const argv: BashToken[] = [];
  let hasRedirect = false;

  for (const child of namedChildren(node)) {
    switch (child.type) {
      case "command_name":
      case "command_name_expr": {
        const inner = firstNamedChild(child) ?? child;
        nameToken = { text: inner.text, value: inner.text, kind: "literal", quoted: false };
        break;
      }
      case "command_elements":
        // 所有参数、参数和重定向的容器
        for (const elem of namedChildren(child)) {
          if (elem.type === "redirection") {
            hasRedirect = true;
          } else {
            tokenizePSElement(elem, argv);
          }
        }
        break;
      case "command_parameter":
        argv.push({ text: child.text, value: child.text, kind: "literal", quoted: false });
        break;
      default:
        tokenizePSElement(child, argv);
        break;
    }
  }

  if (!nameToken) {
    const text = node.text.trim().split(/\s/)[0];
    if (!text) return null;
    nameToken = { text, value: text, kind: "literal", quoted: false };
  }

  return {
    cmd: { text: node.text, name: nameToken.value, nameToken, argv },
    hasRedirect,
  };
}

/**
 * 标记化 PowerShell 元素。
 */
function tokenizePSElement(node: TreeNode, argv: BashToken[]): void {
  switch (node.type) {
    case "command_parameter":
      argv.push({ text: node.text, value: node.text, kind: "literal", quoted: false });
      break;
    case "generic_token":
    case "bareword_string":
      argv.push({ text: node.text, value: node.text, kind: "literal", quoted: false });
      break;
    case "string_literal": {
      // string_literal 包装 expandable_string_literal（双引号）
      // 或 verbatim_string_literal（单引号）。如果包含
      // 插值（sub_expression、variable），标记为未解析。
      const inner = firstNamedChild(node);
      if (inner && inner.type === "expandable_string_literal" && inner.namedChildCount > 0) {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: true });
      } else {
        argv.push({ text: node.text, value: node.text.slice(1, -1), kind: "literal", quoted: true });
      }
      break;
    }
    case "expandable_string_literal":
      if (node.namedChildCount > 0) {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: true });
      } else {
        argv.push({ text: node.text, value: node.text.slice(1, -1), kind: "literal", quoted: true });
      }
      break;
    case "variable":
    case "splatted_variable":
      argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      break;
    case "scriptblock_expression":
    case "sub_expression":
    case "hash_literal_expression":
      argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      break;
    case "array_literal_expression":
    case "unary_expression": {
      // 这些可能包含字符串字面量 — 尝试展开
      const inner = firstNamedChild(node);
      if (inner) {
        tokenizePSElement(inner, argv);
      } else {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      }
      break;
    }
    case "command_argument_sep":
      // 空白分隔符 — 跳过
      break;
    case "redirection":
      // 已在命令级别处理
      break;
    default:
      if (node.text.trim()) {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      }
      break;
  }
}
