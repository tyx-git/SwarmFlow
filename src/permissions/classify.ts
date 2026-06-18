/**
 * Tool classification -- maps a tool call to a PermissionClass.
 *
 * Uses tree-sitter for AST-accurate command parsing (bash and PowerShell).
 * The sync classifyTool returns a conservative write_potent for shell tools;
 * all real classification goes through classifyToolAsync.
 *
 * Risk tiers with git subcommand awareness:
 *   safe -> write_reversible -> write_potent -> write_danger -> catastrophic
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { InvocationAssessment, PermissionClass } from "./types.js";
import type { ParsedBashCommand, ParsedBashSegment } from "./bash/types.js";
import { parseTrackableBashMutation } from "../tools/basic.js";
import { osCapabilities } from "../platform/index.js";
import type { ShellKind } from "../platform/index.js";
import { resolveCdContextParsed } from "./cd-context.js";

// ------------------------------------------------------------------
// Tree-sitter parser (lazy async init)
// ------------------------------------------------------------------

let parserReady: Promise<typeof import("./bash/parser.js")> | null = null;
let parserModule: typeof import("./bash/parser.js") | null = null;

export function initBashParser(): void {
  if (parserReady) return;
  parserReady = import("./bash/parser.js").then(async (mod) => {
    await mod.getParser();
    parserModule = mod;
    return mod;
  }).catch((err) => {
    console.warn("tree-sitter shell parser failed to load:", err);
    parserModule = null;
    return null as any;
  });
}

function isPowerShellKind(kind?: ShellKind): boolean {
  return kind === "pwsh" || kind === "powershell";
}

// ------------------------------------------------------------------
// Static tool classification
// ------------------------------------------------------------------

const READ_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep",
  "web_fetch", "web_search", "$web_search",
  "show_context", "summarize_context",
  "ask", "check_status", "await_event", "send",
  "bash_output", "skill", "reload", "time",
  "kill_shell",
]);

const WRITE_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file",
]);

const SPAWN_TOOLS = new Set([
  "spawn",
]);

const WRITE_DANGER_TOOLS = new Set([
  "kill_agent",
]);

// ------------------------------------------------------------------
// Bash command sets
// ------------------------------------------------------------------

const BASH_SAFE_COMMANDS = new Set([
  "ls", "ll", "la", "dir", "cat", "head", "tail", "less", "more",
  "wc", "file", "stat", "readlink", "realpath", "basename", "dirname",
  "tree",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "pwd", "whoami", "hostname", "uname", "arch", "id", "groups",
  "which", "where", "whence", "type", "command",
  "echo", "printf", "true", "false", "test", "[", "[[", "expr", "seq",
  "sort", "uniq", "cut", "tr", "paste", "nl", "rev", "fmt",
  "comm", "cmp", "diff",
  "jq", "yq",
  "date", "env", "printenv", "uptime", "ps", "df", "du", "free",
  "lsof", "pgrep", "tput",
  "md5sum", "sha256sum", "shasum", "base64",
  "sleep", "tee",
  "cd",
]);

const BASH_REVERSIBLE_COMMANDS = new Set(["mkdir"]);
const BASH_DYNAMIC_REVERSIBLE = new Set(["cp", "mv"]);

// POSIX-shared danger commands. Stored lowercase. The lookup is
// case-sensitive ONLY on case-sensitive filesystems (Linux): there
// `RM` is genuinely a different file from `rm`. On case-insensitive
// filesystems (default macOS, Windows Git Bash) classifyParsedCommand
// lower-cases the parsed name before comparing 鈥?see the
// caseInsensitiveFilesystem capability 鈥?so uppercase spellings
// cannot bypass the gate.
//
// Platform-specific danger commands (Windows registry/disk/network
// tools) live in osCapabilities.platformSpecificDangerCommands and
// are matched case-insensitively because Windows file lookup is
// case-insensitive (REG QUERY 鈫?reg.exe).
const BASH_DANGER_COMMANDS = new Set([
  "rm", "rmdir",
  "sudo", "su", "doas",
  "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff", "init",
  "mount", "umount",
  "iptables", "ip6tables", "nft",
  "systemctl", "service", "launchctl",
  "useradd", "userdel", "usermod", "groupadd", "groupdel",
  "passwd",
  "crontab",
]);

function isDangerCommand(name: string): boolean {
  if (BASH_DANGER_COMMANDS.has(name)) return true;
  // Windows-specific names: lowercased compare so `REG`, `Reg`, `reg`
  // all flag (Git Bash uses Win32 case-insensitive file lookup).
  return osCapabilities.platformSpecificDangerCommands.has(name.toLowerCase());
}

const BASH_POTENT_COMMANDS = new Set([
  "touch", "ln",
  "npm", "npx", "pnpm", "yarn", "bun",
  "pip", "pip3", "uv",
  "cargo", "go",
  "python", "python3", "node", "deno",
  "ruby", "gem", "bundle",
  "java", "javac", "gradle", "mvn",
  "gcc", "g++", "clang", "clang++",
  "make", "cmake",
  "rustc",
  "docker", "podman", "kubectl",
  "bash", "sh", "zsh",
  "sed", "awk", "xargs",
  "curl", "wget",
  "tar", "gzip", "gunzip", "bzip2", "xz", "unzip", "zip",
  "scp", "rsync", "sftp",
  "tsc", "esbuild", "vite", "webpack", "rollup", "parcel",
  "jest", "vitest", "mocha", "pytest",
  "eslint", "prettier", "biome",
  "brew", "apt", "apt-get", "yum", "dnf", "pacman",
  "ssh-keygen",
  "openssl",
]);

const PROCESS_WRAPPERS = new Set([
  "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin",
]);

// ------------------------------------------------------------------
// PowerShell command sets (case-insensitive 鈥?all entries are lowercase)
// ------------------------------------------------------------------

const PS_SAFE_COMMANDS = new Set([
  "get-childitem", "get-content", "get-item", "get-itemproperty",
  "test-path", "resolve-path", "split-path", "join-path",
  "get-location", "get-psdrive",
  "select-string", "select-object", "sort-object", "group-object",
  "where-object", "foreach-object", "measure-object",
  "format-table", "format-list", "format-wide", "format-custom",
  "out-string", "out-null", "out-host",
  "write-output", "write-host", "write-verbose", "write-debug", "write-warning",
  "get-process", "get-service",
  "get-date", "get-random", "get-filehash",
  "get-command", "get-help", "get-alias", "get-module",
  "get-variable", "get-host", "get-culture",
  "compare-object", "measure-command",
  "convertto-json", "convertfrom-json",
  "convertto-csv", "convertfrom-csv",
  "get-acl", "get-executionpolicy",
]);

// Only filesystem-only operations are reversible. cmdlets that can
// target non-filesystem providers (registry, env, etc.) are potent.
const PS_REVERSIBLE_COMMANDS = new Set([
  "add-content",
]);

// Set-Location/Push-Location are potent (not reversible) because
// the cd-context tracker only understands bash `cd` 鈥?PowerShell
// directory changes would bypass external-cwd detection and let
// subsequent reads from outside projectRoot auto-allow silently.
const PS_CWD_COMMANDS = new Set([
  "set-location", "push-location", "pop-location",
]);

const PS_DANGER_COMMANDS = new Set([
  "remove-item", "clear-content", "clear-item",
  "stop-process", "stop-service", "restart-service",
  "remove-itemproperty",
  "clear-recyclebin",
  "restart-computer", "stop-computer",
  "set-executionpolicy",
]);

const PS_POTENT_COMMANDS = new Set([
  "new-item", "copy-item", "move-item", "rename-item",
  "new-itemproperty", "set-itemproperty",
  "set-content", "out-file",
  "invoke-webrequest", "invoke-restmethod",
  "start-process", "start-job", "start-service",
  "invoke-command",
  "new-object",
  "install-module", "import-module", "save-module",
  "install-package",
  "expand-archive", "compress-archive",
  "register-scheduledjob", "register-scheduledtask",
  "set-acl",
]);

/** Dangerous PowerShell patterns: eval-equivalents and code injection vectors. */
const PS_EVAL_COMMANDS = new Set([
  "invoke-expression", "iex",
]);

// PowerShell disk-management cmdlets that irreversibly destroy data 鈥?// escalate to catastrophic (the only class yolo still prompts on),
// mirroring the POSIX mkfs/fdisk/dd handling in classifyParsedCommand.
const PS_CATASTROPHIC_COMMANDS = new Set([
  "format-volume", "clear-disk", "initialize-disk", "remove-partition",
]);

/** PowerShell common aliases 鈫?canonical cmdlet name (lowercase). */
const PS_ALIASES = new Map<string, string>([
  // Navigation
  ["cd", "set-location"], ["chdir", "set-location"],
  ["pushd", "push-location"], ["popd", "pop-location"],
  // Files
  ["ls", "get-childitem"], ["dir", "get-childitem"], ["gci", "get-childitem"],
  ["cat", "get-content"], ["type", "get-content"], ["gc", "get-content"],
  ["cp", "copy-item"], ["copy", "copy-item"], ["ci", "copy-item"],
  ["mv", "move-item"], ["move", "move-item"], ["mi", "move-item"],
  ["rm", "remove-item"], ["del", "remove-item"], ["rd", "remove-item"],
  ["rmdir", "remove-item"], ["erase", "remove-item"], ["ri", "remove-item"],
  ["ren", "rename-item"], ["rni", "rename-item"],
  ["ni", "new-item"], ["md", "new-item"], ["mkdir", "new-item"],
  // Output
  ["echo", "write-output"], ["write", "write-output"],
  // Search
  ["sls", "select-string"],
  // Process
  ["ps", "get-process"], ["gps", "get-process"],
  ["kill", "stop-process"], ["spps", "stop-process"],
  // Filtering / iteration (these execute script blocks!)
  ["where", "where-object"], ["?", "where-object"],
  ["foreach", "foreach-object"], ["%", "foreach-object"],
  // Misc
  ["cls", "clear-host"], ["clear", "clear-host"],
  ["iex", "invoke-expression"],
  ["iwr", "invoke-webrequest"],
  ["irm", "invoke-restmethod"],
  ["icm", "invoke-command"],
  ["sal", "set-alias"],
  ["sv", "set-variable"],
  ["sleep", "start-sleep"],
  ["sc", "set-content"],
  ["ac", "add-content"],
  ["ii", "invoke-item"],
  ["start", "start-process"], ["saps", "start-process"],
]);

// ------------------------------------------------------------------
// Git subcommand sets (only for commands NOT handled by classifyGitDetailed)
// ------------------------------------------------------------------

const GIT_SAFE_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show",
  "rev-parse",
  "ls-files", "ls-tree", "ls-remote",
  "describe", "shortlog", "blame", "annotate",
  "reflog",
  "name-rev", "rev-list",
  "cat-file", "hash-object",
  "count-objects", "fsck", "verify-pack",
  "for-each-ref",
]);

const GIT_REVERSIBLE_SUBCOMMANDS = new Set([
  "add", "commit", "fetch", "pull",
  "switch",
  "merge",
  "cherry-pick",
  "init",
]);

const GIT_DANGER_SUBCOMMANDS = new Set([
  "push", "rebase",
]);

const GIT_FORCE_FLAGS = new Set([
  "--force", "-f", "--force-with-lease", "--hard", "--no-preserve-root",
]);

const GIT_DELETE_FLAGS = new Set([
  "-D", "-d", "--delete",
]);

const CLASS_ORDER: Record<PermissionClass, number> = {
  read: 0,
  spawn: 1,
  write_reversible: 2,
  write_potent: 3,
  write_danger: 4,
  catastrophic: 5,
};

// ------------------------------------------------------------------
// classifyTool 鈥?sync entry point (non-bash only)
// ------------------------------------------------------------------

export function classifyTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
): InvocationAssessment {
  if (toolName.startsWith("mcp__")) {
    return { permissionClass: "write_potent", toolName, canMemoize: true };
  }
  if (READ_TOOLS.has(toolName)) {
    return { permissionClass: "read", toolName };
  }
  if (WRITE_REVERSIBLE_TOOLS.has(toolName)) {
    return { permissionClass: "write_reversible", toolName, canMemoize: true };
  }
  if (SPAWN_TOOLS.has(toolName)) {
    return { permissionClass: "spawn", toolName };
  }
  if (WRITE_DANGER_TOOLS.has(toolName)) {
    return { permissionClass: "write_danger", toolName };
  }

  if (toolName === "bash" || toolName === "bash_background") {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  return { permissionClass: "write_potent", toolName, canMemoize: true };
}

// ------------------------------------------------------------------
// classifyToolAsync 鈥?tree-sitter shell classification
// ------------------------------------------------------------------

export async function classifyToolAsync(
  toolName: string,
  toolArgs: Record<string, unknown>,
  projectRoot?: string,
  shellKind?: ShellKind,
): Promise<InvocationAssessment> {
  if (toolName !== "bash" && toolName !== "bash_background") {
    return classifyTool(toolName, toolArgs);
  }

  const command = typeof toolArgs["command"] === "string" ? toolArgs["command"] : "";
  if (!command.trim()) {
    return { permissionClass: "write_potent", toolName };
  }

  // Ensure parser is loaded (self-init on first use)
  if (!parserModule) {
    if (!parserReady) initBashParser();
    if (parserReady) await parserReady;
  }
  if (!parserModule) {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  const usePS = isPowerShellKind(shellKind);
  const result = usePS
    ? await parserModule.parsePowerShellCommand(command)
    : await parserModule.parseBashCommand(command);
  if (result.kind === "unsupported") {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  const bashCwd = typeof toolArgs["cwd"] === "string" ? toolArgs["cwd"] : undefined;
  const defaultCwd = projectRoot ? path.resolve(projectRoot) : process.cwd();
  const effectiveCwd = bashCwd
    ? path.resolve(defaultCwd, bashCwd)
    : defaultCwd;

  // Phase 1: cd context resolution on parsed AST
  let segments = result.segments as ParsedBashSegment[];
  let cdEffectiveCwd = effectiveCwd;
  let isExternal = false;

  if (projectRoot) {
    // Always check initial cwd externality (covers explicit cwd arg)
    const rel = path.relative(projectRoot, effectiveCwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      isExternal = true;
    }
    // cd context strips cd segments and tracks cwd changes.
    // Only for bash 鈥?PowerShell's cd (Set-Location) can navigate to
    // provider paths (HKLM:\, Env:\, etc.) that the bash resolver
    // doesn't understand. PS cd commands are classified as write_potent
    // via PS_CWD_COMMANDS instead.
    if (!usePS && segments.length > 1) {
      const cdCtx = resolveCdContextParsed(segments, projectRoot, effectiveCwd);
      segments = cdCtx.segments as ParsedBashSegment[];
      cdEffectiveCwd = cdCtx.effectiveCwd;
      if (cdCtx.isExternal) isExternal = true;
    }
  }

  // Phase 2: classify each segment, collect command names and max class
  let maxClass: PermissionClass = "read";
  const allCommandNames: string[] = [];
  const segmentClasses: PermissionClass[] = [];

  for (const segment of segments) {
    let segClass: PermissionClass = "read";
    for (const cmd of segment.commands) {
      const stripped = usePS ? cmd : stripWrappersFromParsed(cmd);
      const cls = usePS ? classifyPSCommand(stripped) : classifyParsedCommand(stripped);
      // Fold so the cp/mv escalation (Phase 5) and memoized rule lookups
      // match `CP`/`MV` like `cp`/`mv` on case-insensitive filesystems.
      allCommandNames.push(usePS ? stripped.name : normalizedCommandName(stripped.name));
      if (CLASS_ORDER[cls] > CLASS_ORDER[segClass]) segClass = cls;
    }
    if (segment.hasFileWriteRedirect && CLASS_ORDER[segClass] < CLASS_ORDER["write_potent"]) {
      segClass = "write_potent";
    }
    segmentClasses.push(segClass);
    if (CLASS_ORDER[segClass] > CLASS_ORDER[maxClass]) maxClass = segClass;
  }

  // Phase 3: safe segment stripping 鈥?if only one non-read segment, keep it
  let effectiveSegments = segments;
  if (segments.length > 1) {
    const nonSafeIndices = segmentClasses
      .map((cls, i) => cls !== "read" ? i : -1)
      .filter(i => i >= 0);
    if (nonSafeIndices.length === 1) {
      effectiveSegments = [segments[nonSafeIndices[0]!]!];
    }
  }

  // Phase 4: memoize from effective segments
  const isSingleCommand = effectiveSegments.length === 1 &&
    effectiveSegments[0]!.commands.length === 1;
  let canMemoize = isSingleCommand && maxClass !== "catastrophic" && !isExternal;
  const canonicalPattern = canMemoize
    ? buildCanonicalPatternFromParsed(
        stripWrappersFromParsed(effectiveSegments[0]!.commands[0]!),
      )
    : undefined;

  const assessment: InvocationAssessment = {
    permissionClass: maxClass,
    toolName,
    commands: allCommandNames,
    canonicalPattern,
    canMemoize,
  };

  if (isExternal) {
    assessment.externalCwd = cdEffectiveCwd;
    assessment.canMemoize = false;
    assessment.canonicalPattern = undefined;
  }

  // Phase 5: dynamic cp/mv check (target is existing directory 鈫?write_potent)
  if (assessment.permissionClass === "write_reversible" &&
      allCommandNames.some(c => BASH_DYNAMIC_REVERSIBLE.has(c))) {
    for (const seg of effectiveSegments) {
      for (const cmd of seg.commands) {
        const stripped = stripWrappersFromParsed(cmd);
        if (!BASH_DYNAMIC_REVERSIBLE.has(normalizedCommandName(stripped.name))) continue;
        const parsed = parseTrackableBashMutation(seg.text);
        if (!parsed) {
          assessment.permissionClass = "write_potent";
          break;
        }
        const rawTarget = parsed.args[parsed.args.length - 1];
        if (rawTarget) {
          const resolvedTarget = path.isAbsolute(rawTarget)
            ? path.resolve(rawTarget)
            : path.resolve(cdEffectiveCwd, rawTarget);
          try {
            if (statSync(resolvedTarget).isDirectory()) {
              assessment.permissionClass = "write_potent";
              break;
            }
          } catch { /* target doesn't exist 鈥?stays reversible */ }
        }
      }
      if (assessment.permissionClass === "write_potent") break;
    }
  }

  return assessment;
}

// ------------------------------------------------------------------
// Per-command classification (tree-sitter)
// ------------------------------------------------------------------

function classifyParsedCommand(cmd: ParsedBashCommand): PermissionClass {
  // Case-folded on case-insensitive filesystems 鈥?see normalizedCommandName.
  const name = normalizedCommandName(cmd.name);

  // Catastrophic: disk tools
  if (["mkfs", "fdisk", "parted", "wipefs", "shred", "dd"].includes(name)) {
    if (name === "dd") {
      const hasDevTarget = cmd.argv.some(
        (t) => t.kind === "literal" && /^of=\/dev\//.test(t.value),
      );
      if (hasDevTarget) return "catastrophic";
    } else {
      return "catastrophic";
    }
  }

  // Catastrophic: platform-specific disk-wipe tools (Windows
  // format/diskpart via Git Bash). Empty set on POSIX, so a command
  // coincidentally named `format` on a POSIX host is never mis-flagged.
  if (osCapabilities.platformSpecificCatastrophicCommands.has(name)) {
    return "catastrophic";
  }

  // Catastrophic: rm -rf targeting root/home
  if (name === "rm") {
    const hasRecursiveForce = cmd.argv.some(
      (t) => t.kind === "literal" && /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r|^--force$/.test(t.value),
    );
    if (hasRecursiveForce) {
      const targetsDangerousPath = cmd.argv.some((t) => {
        if (t.value.startsWith("-")) return false;
        return t.value === "/" || t.value === "~" || t.kind === "home_reference"
          || t.value === ".." || t.value === "$HOME";
      });
      if (targetsDangerousPath) return "catastrophic";
    }
  }

  if (cmd.argv.some((t) => t.value === "--no-preserve-root")) {
    return "catastrophic";
  }

  if (name === "git") return classifyGitDetailed(cmd);

  if (name === "find") {
    const hasDangerous = cmd.argv.some(
      (t) => t.kind === "literal" && /^-(exec|execdir|delete|ok)$/.test(t.value),
    );
    return hasDangerous ? "write_potent" : "read";
  }

  if (isDangerCommand(name)) return "write_danger";
  if (BASH_REVERSIBLE_COMMANDS.has(name)) return "write_reversible";
  if (BASH_DYNAMIC_REVERSIBLE.has(name)) return "write_reversible";
  if (BASH_SAFE_COMMANDS.has(name)) return "read";
  if (BASH_POTENT_COMMANDS.has(name)) return "write_potent";

  return "write_potent";
}

// ------------------------------------------------------------------
// Git detailed subcommand classification
// ------------------------------------------------------------------

function classifyGitDetailed(cmd: ParsedBashCommand): PermissionClass {
  const positionals: string[] = [];
  const flags = new Set<string>();

  for (const token of cmd.argv) {
    if (token.kind !== "literal") continue;
    if (token.value.startsWith("-")) {
      flags.add(token.value);
    } else {
      positionals.push(token.value);
    }
  }

  const sub = positionals[0] ?? "";
  const sub2 = positionals[1] ?? "";
  if (!sub) return "write_potent";

  // Global flag escalation
  if (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease")) return "write_danger";
  if (flags.has("--hard")) return "write_danger";

  switch (sub) {
    case "stash": {
      if (!sub2 || sub2 === "push" || sub2 === "save") return "write_reversible";
      if (sub2 === "list" || sub2 === "show") return "read";
      if (sub2 === "pop" || sub2 === "apply") return "write_reversible";
      if (sub2 === "drop" || sub2 === "clear") return "write_danger";
      return "write_reversible";
    }
    case "checkout": {
      if (flags.has("--")) return "write_danger";
      // `git checkout .` or `git checkout <file>` without -b 鈫?danger
      // Heuristic: if there's a positional that looks like a file path and no -b flag
      if (!flags.has("-b") && !flags.has("-B") && positionals.length >= 2) {
        const target = positionals[1]!;
        if (target === "." || target === "./" || target.includes("/") || target.includes(".")) {
          return "write_danger";
        }
      }
      return "write_reversible";
    }
    case "reset": {
      // --hard already caught by global flag check above
      return "write_reversible";
    }
    case "clean": {
      if (flags.has("-n") || flags.has("--dry-run")) return "read";
      return "write_danger";
    }
    case "branch": {
      if (flags.has("-D") || flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "tag": {
      if (flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "remote": {
      if (!sub2 || sub2 === "show" || sub2 === "get-url") return "read";
      if (sub2 === "add" || sub2 === "rename" || sub2 === "set-url") return "write_reversible";
      if (sub2 === "remove" || sub2 === "rm") return "write_danger";
      return "write_potent";
    }
    case "worktree": {
      if (!sub2 || sub2 === "list") return "read";
      if (sub2 === "add") return "write_reversible";
      if (sub2 === "remove" || sub2 === "prune") return "write_danger";
      return "write_potent";
    }
    case "config": {
      if (flags.has("--unset") || flags.has("--remove-section")) return "write_potent";
      // 1 positional (key) = read, 2+ (key value) = write
      if (positionals.length <= 2) return "read";
      return "write_potent";
    }
    default: break;
  }

  if (GIT_DANGER_SUBCOMMANDS.has(sub)) return "write_danger";
  if (GIT_REVERSIBLE_SUBCOMMANDS.has(sub)) return "write_reversible";
  if (GIT_SAFE_SUBCOMMANDS.has(sub)) return "read";

  return "write_potent";
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Basename of a command, case-folded on case-insensitive filesystems
 * (default macOS APFS, Windows Git Bash over NTFS) so uppercase
 * spellings (`RM`, `ENV`, `NICE`) resolve to the same canonical name the
 * shell would exec. MUST be used by EVERY layer that matches a command
 * name against a safety set 鈥?wrapper stripping, danger/catastrophic
 * classification, and the cp/mv escalation. Folding in only one layer
 * lets an uppercase spelling slip past an earlier case-sensitive layer
 * and land on a more permissive branch: e.g. with wrapper-stripping left
 * case-sensitive, `ENV rm -rf ~` is never unwrapped and the folded `env`
 * reaches the SAFE `env` branch 鈫?`read` (auto-allowed in every mode),
 * strictly WORSE than the unfolded `write_potent`. On case-sensitive
 * Linux the capability is false and the original casing is preserved (a
 * file truly named `RM` is distinct from `rm`).
 */
function normalizedCommandName(rawName: string): string {
  const base = rawName.split("/").pop() ?? rawName;
  return osCapabilities.caseInsensitiveFilesystem ? base.toLowerCase() : base;
}

function stripWrappersFromParsed(cmd: ParsedBashCommand): ParsedBashCommand {
  const name = normalizedCommandName(cmd.name);

  if (name === "env") {
    let idx = 0;
    while (idx < cmd.argv.length) {
      const token = cmd.argv[idx]!;
      if (token.kind === "literal" && token.value.includes("=")) { idx++; continue; }
      if (token.kind === "literal" && token.value.startsWith("-")) { idx++; continue; }
      break;
    }
    if (idx < cmd.argv.length) {
      const newName = cmd.argv[idx]!;
      return { text: cmd.text, name: newName.value, nameToken: newName, argv: cmd.argv.slice(idx + 1) };
    }
  }

  if (!PROCESS_WRAPPERS.has(name)) return cmd;

  let skip = 0;
  while (skip < cmd.argv.length && cmd.argv[skip]!.value.startsWith("-")) skip++;
  if ((name === "timeout" || name === "stdbuf") && skip < cmd.argv.length) {
    if (!cmd.argv[skip]!.value.startsWith("-")) skip++;
  }
  if (skip < cmd.argv.length) {
    const newName = cmd.argv[skip]!;
    return { text: cmd.text, name: newName.value, nameToken: newName, argv: cmd.argv.slice(skip + 1) };
  }

  return cmd;
}

function buildCanonicalPatternFromParsed(cmd: ParsedBashCommand): string {
  const name = normalizedCommandName(cmd.name);

  const subcommandTools = new Set([
    "git", "npm", "npx", "pnpm", "yarn", "docker", "kubectl",
    "cargo", "go", "pip", "brew", "apt", "apt-get",
  ]);

  if (subcommandTools.has(name)) {
    for (const token of cmd.argv) {
      if (token.kind === "literal" && !token.value.startsWith("-")) {
        return `${name} ${token.value}`;
      }
    }
  }

  return name;
}

// ------------------------------------------------------------------
// PowerShell per-command classification
// ------------------------------------------------------------------

/**
 * Resolve a PowerShell command name to its canonical cmdlet (lowercase).
 * Handles aliases and Module\Cmdlet prefix stripping.
 */
function resolvePSCommandName(rawName: string): string {
  let name = rawName.toLowerCase();
  // Strip surrounding quotes: & "Remove-Item" or & 'rm'
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1);
  }
  // Strip module prefix: Microsoft.PowerShell.Management\Get-ChildItem 鈫?get-childitem
  const backslash = name.lastIndexOf("\\");
  if (backslash >= 0) name = name.slice(backslash + 1);
  // Resolve alias
  return PS_ALIASES.get(name) ?? name;
}

// PowerShell accepts unambiguous parameter prefixes: -e, -en, -enc, ...
// all resolve to -EncodedCommand. Minimum 2 chars after dash.
function isEncodedCommandFlag(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("-e") && "-encodedcommand".startsWith(lower);
}

/** Check if `value` is a valid PowerShell prefix of `fullParam` (e.g. "-rec" matches "-recurse"). */
function isPSParamPrefix(value: string, fullParam: string): boolean {
  const lower = value.toLowerCase();
  return lower.length >= 2 && lower.startsWith("-") && fullParam.startsWith(lower);
}

/** Check if any argv token contains executable PowerShell code:
 *  script blocks `{ ... }`, subexpressions `$(...)`, or grouped
 *  command expressions `(...)`. */
function hasExecutableExpression(cmd: ParsedBashCommand): boolean {
  return cmd.argv.some(
    (t) => t.kind === "unresolved_expression" &&
      (t.text.includes("{") || t.text.includes("$(") || t.text.startsWith("(")),
  );
}

function classifyPSCommand(cmd: ParsedBashCommand): PermissionClass {
  const name = resolvePSCommandName(cmd.name);

  // Eval-equivalent commands are always dangerous.
  if (PS_EVAL_COMMANDS.has(name)) return "write_danger";

  // Dangerous flags: -EncodedCommand on pwsh/powershell re-invocation.
  // PowerShell accepts unambiguous parameter prefixes, so -enc, -en, -e
  // all resolve to -EncodedCommand.
  if (name === "pwsh" || name === "powershell" || name === "powershell.exe" || name === "pwsh.exe") {
    const hasEncoded = cmd.argv.some(
      (t) => t.kind === "literal" && isEncodedCommandFlag(t.value),
    );
    if (hasEncoded) return "write_danger";
    return "write_potent";
  }

  // Native executables that pass through (git, npm, etc.) use the
  // same bash classification since they're not PowerShell-specific.
  if (name === "git") return classifyGitDetailed(cmd);

  // Catastrophic: Remove-Item -Recurse -Force targeting root/home/drive.
  if (name === "remove-item") {
    const hasRecurse = cmd.argv.some(
      (t) => t.kind === "literal" && isPSParamPrefix(t.value, "-recurse"),
    );
    const hasForce = cmd.argv.some(
      (t) => t.kind === "literal" && isPSParamPrefix(t.value, "-force"),
    );
    if (hasRecurse && hasForce) {
      const targetsDangerousPath = cmd.argv.some((t) => {
        if (t.value.startsWith("-")) return false;
        // Normalize: strip trailing slashes, backslashes, wildcards, and dots.
        // This catches C:\, C:\*, C:\., ~\*, etc.
        const v = t.value.replace(/[\\/]+$/, "").replace(/[\\/][.*]+$/, "").replace(/[\\/]+$/, "");
        // Drive roots: C:, C:\, /
        if (/^[a-z]:?$/i.test(v) || v === "/" || v === "\\") return true;
        // Home references
        if (v === "~" || v === "$HOME" || /^\$env:USERPROFILE$/i.test(v) || /^\$env:HOME$/i.test(v)) return true;
        // System paths
        if (/^\$env:(SYSTEMROOT|WINDIR|PROGRAMFILES)$/i.test(v)) return true;
        return false;
      });
      if (targetsDangerousPath) return "catastrophic";
    }
    return "write_danger";
  }

  // Catastrophic: PowerShell disk-wipe cmdlets, plus the Windows
  // format/diskpart exes when invoked from PowerShell (empty set off
  // Windows). Checked before the danger set so they escalate fully.
  if (PS_CATASTROPHIC_COMMANDS.has(name)) return "catastrophic";
  if (osCapabilities.platformSpecificCatastrophicCommands.has(name)) return "catastrophic";

  // Check PowerShell-specific command sets.
  if (PS_DANGER_COMMANDS.has(name)) return "write_danger";

  // Add-Type is runtime .NET compilation 鈥?potent.
  if (name === "add-type") return "write_potent";

  // invoke-item / ii is ShellExecute 鈥?can run arbitrary executables.
  if (name === "invoke-item") return "write_danger";

  if (PS_CWD_COMMANDS.has(name)) return "write_potent";
  if (PS_POTENT_COMMANDS.has(name)) return "write_potent";
  if (PS_REVERSIBLE_COMMANDS.has(name)) return "write_reversible";

  // Safe commands 鈥?but if they receive a script block argument,
  // that block can contain arbitrary code (e.g. ForEach-Object { rm foo }).
  // Escalate to write_potent so the user gets prompted.
  if (PS_SAFE_COMMANDS.has(name)) {
    // Script blocks and subexpressions can contain arbitrary code
    // (including deletes). We can't inspect their contents statically,
    // so escalate to write_danger, which prompts in read_only/reversible
    // modes. (yolo only force-prompts `catastrophic`, so a script-block
    // delete still auto-runs there; classifying every script-block-
    // bearing read cmdlet as catastrophic would be far too aggressive.)
    return hasExecutableExpression(cmd) ? "write_danger" : "read";
  }

  // Native executables that also appear in the bash sets.
  if (isDangerCommand(name)) return "write_danger";
  if (BASH_SAFE_COMMANDS.has(name)) return "read";
  if (BASH_POTENT_COMMANDS.has(name)) return "write_potent";

  // Unknown commands default to potent (fail-safe).
  return "write_potent";
}
