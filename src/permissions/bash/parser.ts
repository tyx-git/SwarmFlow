/**
 * Tree-sitter-based shell command parser.
 *
 * Supports both bash and PowerShell grammars. Parses commands into
 * structured segments for permission classification. Unsupported
 * constructs are flagged explicitly 鈥?the classifier can escalate
 * them to "ask".
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

const DEFAULT_TIMEOUT_MS = 50;

// ------------------------------------------------------------------
// WASM resolution
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
// Singleton parser initialization 鈥?loads both bash and PowerShell
// ------------------------------------------------------------------

// Bash parser 鈥?always loaded (used on all platforms).
let bashParserInit: Promise<Parser> | null = null;
let parserRuntimeReady = false;

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

export async function getParser(): Promise<Parser> {
  if (!bashParserInit) bashParserInit = initializeBashParser();
  return bashParserInit;
}

// PowerShell parser 鈥?lazy-loaded only when shellKind is pwsh/powershell,
// so a missing WASM file on macOS/Linux never degrades the bash classifier.
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
 * Parse a bash command string into structured segments.
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
// AST walking
// ------------------------------------------------------------------

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
      // Standalone file_redirect outside a redirected_statement 鈥?safe to ignore
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
      // Standalone variable assignment (e.g. `FOO=bar`) is a no-op in subprocess 鈥?skip
      return;
    default:
      if (node.isNamed) {
        return unsupported("unsupported_node", `Unsupported shell node: ${node.type}`, node);
      }
      return;
  }
}

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
 * Handle `redirected_statement`: unwrap the inner command / pipeline / list,
 * and check if the redirect writes to a real file (vs /dev/null or an fd dup).
 *
 * When the inner is a `list` (e.g. `cd x && npm install 2>&1`), recurse so the
 * `&&` / `||` / `;` chain expands into per-command segments; otherwise a
 * trailing redirect would force the whole compound into the unsupported path
 * and disable memoization.
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
      // Determine if this redirect writes to a real file
      const redirectTarget = getRedirectTarget(child);
      if (redirectTarget && redirectTarget !== "/dev/null") {
        hasFileWrite = true;
      }
    }
  }

  if (!innerNode) {
    return unsupported("unsupported_node", "Redirected statement has no inner command.", node);
  }

  // Compound inner (`cmd1 && cmd2 > out`): walk the list so each command
  // becomes its own segment, then attach the file-write flag to the final
  // segment (bash binds a trailing redirect to the last command).
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

function getRedirectTarget(fileRedirectNode: TreeNode): string | null {
  for (let i = 0; i < fileRedirectNode.childCount; i++) {
    const child = fileRedirectNode.child(i);
    if (!child) continue;
    // The target is typically a "word" node after the operator (>, >>, 2>)
    if (child.type === "word" || child.type === "string" || child.type === "raw_string") {
      return child.text.replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Command tokenization
// ------------------------------------------------------------------

function tokenizeCommandNode(node: TreeNode): ParsedBashCommand | UnsupportedBashScript {
  const tokens: BashToken[] = [];
  let nameToken: BashToken | null = null;

  for (const child of namedChildren(node)) {
    // VAR=val prefix before a command 鈥?skip, classify the real command
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

function tokenizeExpansion(node: TreeNode): BashToken {
  const isHome = node.text === "$HOME" || node.text === "${HOME}";
  return {
    text: node.text,
    value: node.text,
    kind: isHome ? "home_reference" : "unresolved_expression",
    quoted: false,
  };
}

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
// Forbidden node detection
// ------------------------------------------------------------------

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
// Helpers
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
// PowerShell parser
// ------------------------------------------------------------------

/**
 * Parse a PowerShell command string into structured segments.
 *
 * Uses tree-sitter-powershell for AST-accurate parsing. The output
 * reuses the same BashParseResult / ParsedBashCommand types so the
 * classifier can handle both shell kinds uniformly.
 *
 * AST structure (tree-sitter-powershell):
 *   program 鈫?statement_list 鈫?pipeline 鈫?pipeline_chain 鈫?command
 *   Pipeline chains (&&/||) split into multiple pipeline_chain nodes.
 *   Command arguments live under a `command_elements` container.
 *   Redirections appear as `redirection` nodes inside command_elements.
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

  // Safety guard: if non-empty input produced zero segments, the AST
  // contained constructs we didn't recognize 鈥?escalate to unsupported.
  if (segments.length === 0 && command.trim().length > 0) {
    return unsupported("unsupported_node", "PowerShell command structure not recognized; requires manual approval.");
  }

  return { kind: "ok", segments };
}

// Walk the PowerShell AST top-down, collecting command segments.
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
      // A pipeline contains one or more pipeline_chain nodes.
      // Each pipeline_chain may contain piped commands (cmd | cmd).
      // Multiple pipeline_chains are linked by pipeline_chain_tail (&&/||).
      for (const child of namedChildren(node)) {
        walkPSNode(child, segments);
      }
      return;
    }

    case "pipeline_chain": {
      // Collect all commands in this chain (may be piped: cmd | cmd).
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

    // Skip these structural nodes.
    case "pipeline_chain_tail":
    case "empty_statement":
      return;

    default:
      // Recurse into any unrecognized container that might hold commands.
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
        // Container for all arguments, parameters, and redirections.
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
      // string_literal wraps expandable_string_literal (double-quoted)
      // or verbatim_string_literal (single-quoted). If it contains
      // interpolation (sub_expression, variable), mark as unresolved.
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
      // These may contain string literals 鈥?try to unwrap.
      const inner = firstNamedChild(node);
      if (inner) {
        tokenizePSElement(inner, argv);
      } else {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      }
      break;
    }
    case "command_argument_sep":
      // Whitespace separator 鈥?skip.
      break;
    case "redirection":
      // Already handled at the command level.
      break;
    default:
      if (node.text.trim()) {
        argv.push({ text: node.text, value: node.text, kind: "unresolved_expression", quoted: false });
      }
      break;
  }
}
