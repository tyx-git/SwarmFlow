/**
 * 工具分类 — 将工具调用映射到 PermissionClass。
 *
 * 使用 tree-sitter 进行 AST 精确的命令解析（bash 和 PowerShell）。
 * 同步的 classifyTool 对 shell 工具返回保守的 write_potent；
 * 所有真正的分类都通过 classifyToolAsync。
 *
 * 风险层级（带有 git 子命令感知）：
 *   safe -> write_reversible -> write_potent -> write_danger -> catastrophic
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { InvocationAssessment, PermissionClass } from "./types.js";
import type { ParsedBashCommand, ParsedBashSegment } from "./bash/types.js";
import { parseTrackableBashMutation } from "../tools/mutations.js";
import { osCapabilities } from "../platform/index.js";
import type { ShellKind } from "../platform/index.js";
import { resolveCdContextParsed } from "./cd-context.js";
import { BASH_DYNAMIC_REVERSIBLE, BASH_POTENT_COMMANDS, BASH_REVERSIBLE_COMMANDS, BASH_SAFE_COMMANDS, PROCESS_WRAPPERS, PS_ALIASES, PS_CATASTROPHIC_COMMANDS, PS_CWD_COMMANDS, PS_DANGER_COMMANDS, PS_EVAL_COMMANDS, PS_POTENT_COMMANDS, PS_REVERSIBLE_COMMANDS, PS_SAFE_COMMANDS, READ_TOOLS, SPAWN_TOOLS, WRITE_DANGER_TOOLS, WRITE_REVERSIBLE_TOOLS, isDangerCommand } from "./command-catalog.js";
import { classifyGitDetailed } from "./git-subcommand-rules.js";

// ------------------------------------------------------------------
// Tree-sitter 解析器（延迟异步初始化）
// ------------------------------------------------------------------

let parserReady: Promise<typeof import("./bash/parser.js")> | null = null;

let parserModule: typeof import("./bash/parser.js") | null = null;

/** 初始化 bash 解析器 */
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
// 静态工具分类
// ------------------------------------------------------------------

/** 权限类别排序 */
const CLASS_ORDER: Record<PermissionClass, number> = {
  read: 0,
  spawn: 1,
  write_reversible: 2,
  write_potent: 3,
  write_danger: 4,
  catastrophic: 5,
};

// ------------------------------------------------------------------
// classifyTool — 同步入口点（非 bash 专用）
// ------------------------------------------------------------------

/**
 * 对工具调用进行同步分类。
 * 用于非 bash 工具和解析失败的情况。
 */
export function classifyTool(
  toolName: string,
  _toolArgs: Record<string, unknown>,
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
// classifyToolAsync — tree-sitter shell 分类
// ------------------------------------------------------------------

/**
 * 异步工具分类 — 使用 tree-sitter 解析 shell 命令。
 */
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

  // 确保解析器已加载（首次使用自初始化）
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

  // 阶段 1：在解析的 AST 上进行 cd 上下文解析
  let segments = result.segments as ParsedBashSegment[];
  let cdEffectiveCwd = effectiveCwd;
  let isExternal = false;

  if (projectRoot) {
    // 始终检查初始 cwd 的外部性（覆盖显式 cwd 参数）
    const rel = path.relative(projectRoot, effectiveCwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      isExternal = true;
    }
    // cd 上下文剥离 cd 段并跟踪 cwd 更改。
    // 仅限 bash — PowerShell 的 cd（Set-Location）可以导航到
    // bash 解析器不理解的提供程序路径（HKLM:\、Env:\ 等）。
    // PS cd 命令通过 PS_CWD_COMMANDS 分类为 write_potent。
    if (!usePS && segments.length > 1) {
      const cdCtx = resolveCdContextParsed(segments, projectRoot, effectiveCwd);
      segments = cdCtx.segments as ParsedBashSegment[];
      cdEffectiveCwd = cdCtx.effectiveCwd;
      if (cdCtx.isExternal) isExternal = true;
    }
  }

  // 阶段 2：对每个段进行分类，收集命令名称和最大类别
  let maxClass: PermissionClass = "read";
  const allCommandNames: string[] = [];
  const segmentClasses: PermissionClass[] = [];

  for (const segment of segments) {
    let segClass: PermissionClass = "read";
    for (const cmd of segment.commands) {
      const stripped = usePS ? cmd : stripWrappersFromParsed(cmd);
      const cls = usePS ? classifyPSCommand(stripped) : classifyParsedCommand(stripped);
      // 大写折叠，使 cp/mv 升级（第 5 阶段）和记忆化规则查找
      // 在不区分大小写的文件系统上匹配 `CP`/`MV` 如 `cp`/`mv`。
      allCommandNames.push(usePS ? stripped.name : normalizedCommandName(stripped.name));
      if (CLASS_ORDER[cls] > CLASS_ORDER[segClass]) segClass = cls;
    }
    if (segment.hasFileWriteRedirect && CLASS_ORDER[segClass] < CLASS_ORDER["write_potent"]) {
      segClass = "write_potent";
    }
    segmentClasses.push(segClass);
    if (CLASS_ORDER[segClass] > CLASS_ORDER[maxClass]) maxClass = segClass;
  }

  // 阶段 3：安全段剥离 — 如果只有一个非只读段，保留它
  let effectiveSegments = segments;
  if (segments.length > 1) {
    const nonSafeIndices = segmentClasses
      .map((cls, i) => cls !== "read" ? i : -1)
      .filter(i => i >= 0);
    if (nonSafeIndices.length === 1) {
      effectiveSegments = [segments[nonSafeIndices[0]!]!];
    }
  }

  // 阶段 4：从有效段记忆化
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

  // 阶段 5：动态 cp/mv 检查（目标是现有目录 → write_potent）
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
          } catch { /* 目标不存在 — 保持可逆 */ }
        }
      }
      if (assessment.permissionClass === "write_potent") break;
    }
  }

  return assessment;
}

// ------------------------------------------------------------------
// 每个命令的分类（tree-sitter）
// ------------------------------------------------------------------

/**
 * 对解析后的 bash 命令进行分类。
 * 在不区分大小写的文件系统上大小写折叠 — 参见 normalizedCommandName。
 */
function classifyParsedCommand(cmd: ParsedBashCommand): PermissionClass {
  const name = normalizedCommandName(cmd.name);

  // 灾难性：磁盘工具
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

  // 灾难性：平台特定磁盘擦除工具（Windows
  // format/diskpart 通过 Git Bash）。在 POSIX 上为空集，
  // 所以在 POSIX 主机上恰好命名为 `format` 的命令不会被错误标记。
  if (osCapabilities.platformSpecificCatastrophicCommands.has(name)) {
    return "catastrophic";
  }

  // 灾难性：rm -rf 针对根/主目录
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
// Git 详细子命令分类
// ------------------------------------------------------------------

/**
 * 命令的基名，在不区分大小写的文件系统上大小写折叠
 *（macOS APFS 和 Windows Git Bash over NTFS 默认），
 * 使大写拼写（`RM`、`ENV`、`NICE`）解析到与 shell
 * 执行的相同规范名称。必须在每个层使用 — 包装器剥离、
 * 危险/灾难性分类和 cp/mv 升级。只在一个层折叠
 * 会让大写拼写绕过较早的大小写敏感层，
 * 落到更宽松的分支：例如包装器剥离保持大小写敏感，
 * `ENV rm -rf ~` 永远不会被展开，折叠的 `env`
 * 到达安全的 `env` 分支 → `read`（每种模式自动允许），
 * 比未折叠的 `write_potent` 严格更差。在区分大小写的
 * Linux 上能力为 false，保留原始大小写
 *（名为 `RM` 的文件与 `rm` 确实不同）。
 */
function normalizedCommandName(rawName: string): string {
  const base = rawName.split("/").pop() ?? rawName;
  return osCapabilities.caseInsensitiveFilesystem ? base.toLowerCase() : base;
}

/**
 * 从解析后的命令中剥离包装器。
 * 如 `env git status` → `git status`。
 */
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

/**
 * 从解析后的命令构建规范模式。
 * 用于记忆化规则匹配。
 */
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
// PowerShell 每个命令的分类
// ------------------------------------------------------------------

/**
 * 将 PowerShell 命令名称解析为其规范 cmdlet（小写）。
 * 处理别名和 Module\Cmdlet 前缀剥离。
 */
function resolvePSCommandName(rawName: string): string {
  let name = rawName.toLowerCase();
  // 剥离周围引号：& "Remove-Item" 或 & 'rm'
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1);
  }
  // 剥离模块前缀：Microsoft.PowerShell.Management\Get-ChildItem → get-childitem
  const backslash = name.lastIndexOf("\\");
  if (backslash >= 0) name = name.slice(backslash + 1);
  // 解析别名
  return PS_ALIASES.get(name) ?? name;
}

// PowerShell 接受明确的参数前缀：-e、-en、-enc...
// 都解析为 -EncodedCommand。破折号后最少 2 个字符。
function isEncodedCommandFlag(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("-e") && "-encodedcommand".startsWith(lower);
}

/** 检查 `value` 是否是 `fullParam` 的有效 PowerShell 前缀（如 "-rec" 匹配 "-recurse"）*/
function isPSParamPrefix(value: string, fullParam: string): boolean {
  const lower = value.toLowerCase();
  return lower.length >= 2 && lower.startsWith("-") && fullParam.startsWith(lower);
}

/** 检查任何 argv 标记是否包含可执行的 PowerShell 代码：
 *  脚本块 `{ ... }`、子表达式 `$(...)` 或分组
 *  命令表达式 `(...)`。 */
function hasExecutableExpression(cmd: ParsedBashCommand): boolean {
  return cmd.argv.some(
    (t) => t.kind === "unresolved_expression" &&
      (t.text.includes("{") || t.text.includes("$(") || t.text.startsWith("(")),
  );
}

/**
 * 对 PowerShell 命令进行分类。
 */
function classifyPSCommand(cmd: ParsedBashCommand): PermissionClass {
  const name = resolvePSCommandName(cmd.name);

  // Eval 等价命令始终危险
  if (PS_EVAL_COMMANDS.has(name)) return "write_danger";

  // 危险标志：pwsh/powershell 重新调用上的 -EncodedCommand。
  // PowerShell 接受明确的参数前缀，所以 -enc、-en、-e
  // 都解析为 -EncodedCommand。
  if (name === "pwsh" || name === "powershell" || name === "powershell.exe" || name === "pwsh.exe") {
    const hasEncoded = cmd.argv.some(
      (t) => t.kind === "literal" && isEncodedCommandFlag(t.value),
    );
    if (hasEncoded) return "write_danger";
    return "write_potent";
  }

  // 通过的本机可执行文件（git、npm 等）使用相同的
  // bash 分类，因为它们不是 PowerShell 特定的。
  if (name === "git") return classifyGitDetailed(cmd);

  // 灾难性：Remove-Item -Recurse -Force 针对根/主目录/驱动器
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
        // 规范化：剥离尾随斜杠、反斜杠、通配符和点。
        // 这捕获 C:\、C:\*、C:\. 等。
        const v = t.value.replace(/[\\/]+$/, "").replace(/[\\/][.*]+$/, "").replace(/[\\/]+$/, "");
        // 驱动器根：C:、C:\、/
        if (/^[a-z]:?$/i.test(v) || v === "/" || v === "\\") return true;
        // 主目录引用
        if (v === "~" || v === "$HOME" || /^\$env:USERPROFILE$/i.test(v) || /^\$env:HOME$/i.test(v)) return true;
        // 系统路径
        if (/^\$env:(SYSTEMROOT|WINDIR|PROGRAMFILES)$/i.test(v)) return true;
        return false;
      });
      if (targetsDangerousPath) return "catastrophic";
    }
    return "write_danger";
  }

  // 灾难性：PowerShell 磁盘擦除 cmdlet，加上从 PowerShell
  // 调用时的 Windows format/diskpart 可执行文件（非 Windows 上为空集）。
  // 在危险集之前检查，所以它们完全升级。
  if (PS_CATASTROPHIC_COMMANDS.has(name)) return "catastrophic";
  if (osCapabilities.platformSpecificCatastrophicCommands.has(name)) return "catastrophic";

  // 检查 PowerShell 特定命令集
  if (PS_DANGER_COMMANDS.has(name)) return "write_danger";

  // Add-Type 是运行时 .NET 编译 — 强能力
  if (name === "add-type") return "write_potent";

  // invoke-item / ii 是 ShellExecute — 可以运行任意可执行文件
  if (name === "invoke-item") return "write_danger";

  if (PS_CWD_COMMANDS.has(name)) return "write_potent";
  if (PS_POTENT_COMMANDS.has(name)) return "write_potent";
  if (PS_REVERSIBLE_COMMANDS.has(name)) return "write_reversible";

  // 安全命令 — 但如果它们接收脚本块参数，
  // 该块可以包含任意代码（包括删除）。
  // 升级到 write_potent，让用户收到提示。
  if (PS_SAFE_COMMANDS.has(name)) {
    // 脚本块和子表达式可以包含任意代码
    //（包括删除）。我们无法静态检查它们的内容，
    // 所以升级到 write_danger，这会在 read_only/reversible
    // 模式下提示。（yolo 只强制提示 `catastrophic`，
    // 所以脚本块删除仍会在那里自动运行；
    // 将每个携带脚本块的只读 cmdlet 分类为 catastrophic
    // 会过于激进。）
    return hasExecutableExpression(cmd) ? "write_danger" : "read";
  }

  // 也出现在 bash 集合中的本机可执行文件
  if (isDangerCommand(name)) return "write_danger";
  if (BASH_SAFE_COMMANDS.has(name)) return "read";
  if (BASH_POTENT_COMMANDS.has(name)) return "write_potent";

  // 未知命令默认为强能力（故障安全）
  return "write_potent";
}
