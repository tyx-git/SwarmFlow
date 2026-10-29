/**
 * PermissionAdvisor — 做出 allow/ask/deny 决策的主要 GateAdvisor。
 *
 * 流程：
 *   1. 对工具调用进行分类 → InvocationAssessment
 *   2. 外部路径门控（项目根目录外的文件工具）
 *   3. bash 外部 cwd / 外部写入目标门控
 *   4. 检查持久化规则 → 如果匹配 allow，快速短路为 allow
 *   5. 应用决策矩阵（mode × class → allow/ask）
 *   6. 为 ask 决策构建审批选项
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { toPosixPath } from "../security/path.js";
import type { GateAdvisor, GateDecision } from "../tools/runtime.js";
import type { ToolPreflightContext } from "../agents/tool-loop/types.js";
import { classifyToolAsync } from "./classify.js";
import { PermissionRuleStore } from "./rules.js";
import type { ShellKind } from "../platform/types.js";
import type {
  PermissionMode,
  InvocationAssessment,
  ApprovalOffer,
  PermissionRule,
  ToolPatternRule,
  ExternalPathRule,
} from "./types.js";
import { effectiveMode } from "./types.js";

// 需要检查外部访问的 `path` 参数的文件工具
const FILE_TOOLS_WITH_PATH = new Set([
  "read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "find_symbol", "jq",
]);

// ------------------------------------------------------------------
// PermissionAdvisor
// ------------------------------------------------------------------

export class PermissionAdvisor implements GateAdvisor {
  private _ruleStore: PermissionRuleStore;
  private _sessionMode: PermissionMode;
  private _agentCeiling?: PermissionMode;
  private _projectRoot: string;
  private _shellKind: ShellKind;

  /** 此会话的内存 "allow once" 授权（toolCallId → true） */
  private _allowOnceGrants = new Set<string>();

  constructor(opts: {
    /** 规则存储 */
    ruleStore: PermissionRuleStore;
    /** 会话模式（默认：reversible） */
    sessionMode?: PermissionMode;
    /** 代理上限 */
    agentCeiling?: PermissionMode;
    /** 项目根目录（默认：当前目录） */
    projectRoot?: string;
    /** Shell 类型（默认：bash） */
    shellKind?: ShellKind;
  }) {
    this._ruleStore = opts.ruleStore;
    this._sessionMode = opts.sessionMode ?? "reversible";
    this._agentCeiling = opts.agentCeiling;
    this._projectRoot = opts.projectRoot ?? process.cwd();
    this._shellKind = opts.shellKind ?? "bash";
  }

  get sessionMode(): PermissionMode {
    return this._sessionMode;
  }

  set sessionMode(mode: PermissionMode) {
    this._sessionMode = mode;
  }

  get ruleStore(): PermissionRuleStore {
    return this._ruleStore;
  }

  get projectRoot(): string {
    return this._projectRoot;
  }

  // -- GateAdvisor 接口 -------------------------------------------

  async evaluate(ctx: ToolPreflightContext): Promise<GateDecision> {
    const assessment = await classifyToolAsync(ctx.toolName, ctx.toolArgs, this._projectRoot, this._shellKind);
    const mode = effectiveMode(this._sessionMode, this._agentCeiling);

    // 1. 检查 allow-once 授权
    if (this._allowOnceGrants.has(ctx.toolCallId)) {
      return { kind: "allow" };
    }

    // 2. 文件工具的外部路径门控（yolo 绕过）
    if (mode !== "yolo" && FILE_TOOLS_WITH_PATH.has(ctx.toolName)) {
      const externalDecision = this._checkExternalPath(ctx, assessment, mode);
      if (externalDecision) return externalDecision;
    }

    // 3. bash 的外部 cwd 门控（在外部上下文时跳过项目规则）
    if (assessment.externalCwd && mode !== "yolo") {
      const offers = this._buildOffers(assessment, mode);
      return {
        kind: "ask",
        question: this._buildQuestion(ctx, assessment),
        toolCallId: ctx.toolCallId,
        offers,
        assessment,
      };
    }

    // 3b. bash 的外部写入目标（重定向/路径参数）
    if (mode !== "yolo" && assessment.permissionClass !== "catastrophic" && assessment.externalWrites?.length) {
      const externalWriteDecision = this._checkExternalWrites(ctx, assessment);
      if (externalWriteDecision) return externalWriteDecision;
    }

    // 4. 检查持久化规则（在 read_only 中跳过 — 模式是硬上限）
    if (mode !== "read_only") {
      const matchingRule = this._ruleStore.findMatchingRule(assessment);
      if (matchingRule) {
        if (matchingRule.action === "deny") {
          return { kind: "deny", message: `Denied by rule: ${matchingRule.id}` };
        }
        // allow 规则 — 但 catastrophic 始终询问
        if (assessment.permissionClass !== "catastrophic") {
          return { kind: "allow" };
        }
      }
    }

    // 5. 决策矩阵
    const decision = this._applyMatrix(mode, assessment);
    if (decision === "allow") {
      return { kind: "allow" };
    }

    // 6. 构建审批选项
    const offers = this._buildOffers(assessment, mode);
    return {
      kind: "ask",
      question: this._buildQuestion(ctx, assessment),
      toolCallId: ctx.toolCallId,
      offers,
      assessment,
    };
  }

  // -- Allow-once 管理 -------------------------------------------

  /** 授权单次允许 */
  grantAllowOnce(toolCallId: string): void {
    this._allowOnceGrants.add(toolCallId);
  }

  /** 从接受的审批选项持久化规则 */
  acceptOffer(offer: ApprovalOffer): void {
    if (offer.rule) {
      this._ruleStore.addRule(offer.rule);
    }
  }

  // -- 外部路径检查 -----------------------------------------

  /**
   * 检查文件工具是否访问外部路径。
   */
  private _checkExternalPath(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
    _mode: PermissionMode,
  ): GateDecision | null {
    const args = ctx.toolArgs as Record<string, unknown>;
    const rawPath = typeof args["path"] === "string" ? args["path"] : null;
    if (!rawPath) return null;

    const resolvedPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this._projectRoot, rawPath);

    const rel = path.relative(this._projectRoot, resolvedPath);
    const isExternal = rel.startsWith("..") || path.isAbsolute(rel);
    if (!isExternal) return null;

    // 根据工具确定访问类型
    const isWrite = ctx.toolName === "write_file" || ctx.toolName === "edit_file";
    const accessKind = isWrite ? "write_reversible" as const : "read" as const;

    // 计算目录前缀：目录使用自身，文件使用父目录。
    // 规范化为正斜杠形式，这样在 Windows 上创建的规则
    // （path.resolve 返回 `\` 分隔的路径）可以正确比较后续调用。
    const subject = toPosixPath(resolvedPath);
    let dirPrefix: string;
    if (subject.endsWith("/")) {
      dirPrefix = subject;
    } else {
      let isDir = false;
      try { isDir = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory(); } catch { /* 忽略 */ }
      dirPrefix = isDir ? subject + "/" : toPosixPath(path.dirname(resolvedPath)) + "/";
    }

    // 检查现有的外部路径规则
    const matchingRule = this._ruleStore.findMatchingExternalPathRule(resolvedPath, accessKind);
    if (matchingRule) return null; // 规则允许，继续正常流程

    // 构建外部路径选项 — 无 "Allow once"（执行器需要持久化规则用于写入；
    // 对于读取，session 作用域足够窄）。无 mode_upgrade（外部路径规则是正确的机制，而不是模式切换）。
    assessment.externalPathPrefix = dirPrefix;
    const offers: ApprovalOffer[] = [];

    const kindLabel = isWrite ? "read/write" : "read";
    const shortDir = dirPrefix.length > 50 ? "..." + dirPrefix.slice(-47) : dirPrefix;

    for (const scope of ["session", "project"] as const) {
      const scopeLabel = scope === "session" ? "in this session" : "in this project";
      const rule: Omit<ExternalPathRule, "id" | "createdAt"> = {
        type: "external_path",
        action: "allow",
        accessKind,
        pathPrefix: dirPrefix,
        scope,
      };
      offers.push({
        type: "external_path",
        label: `Allow ${kindLabel} from ${shortDir} ${scopeLabel}`,
        scope,
        rule: rule as PermissionRule,
      });
    }

    return {
      kind: "ask",
      question: `${ctx.toolName} accesses external path: ${resolvedPath}`,
      toolCallId: ctx.toolCallId,
      offers,
      assessment,
    };
  }

  /**
   * bash 的写入目标在工作区外时询问。
   * 已被 external_path 规则覆盖的目标不重复询问；其余目标提供规则化选项。
   */
  private _checkExternalWrites(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
  ): GateDecision | null {
    const uncovered = (assessment.externalWrites ?? []).filter(
      (target) => !this._ruleStore.findMatchingExternalPathRule(target, "write_reversible"),
    );
    if (uncovered.length === 0) return null;

    const offers: ApprovalOffer[] = [{ type: "tool_once", label: "Allow once" }];
    const firstAbsolute = uncovered.find((target) => path.isAbsolute(target));
    if (firstAbsolute) {
      const dirPrefix = toPosixPath(path.dirname(firstAbsolute)) + "/";
      const filesystemRoot = toPosixPath(path.parse(firstAbsolute).root) + "/";
      assessment.externalPathPrefix = dirPrefix;
      // 不提供从文件系统根/盘符根持久放行的选项。
      if (dirPrefix !== filesystemRoot) {
        const shortDir = dirPrefix.length > 50 ? "..." + dirPrefix.slice(-47) : dirPrefix;
        for (const scope of ["session", "project"] as const) {
          const scopeLabel = scope === "session" ? "in this session" : "in this project";
          const rule: Omit<ExternalPathRule, "id" | "createdAt"> = {
            type: "external_path",
            action: "allow",
            accessKind: "write_reversible",
            pathPrefix: dirPrefix,
            scope,
          };
          offers.push({
            type: "external_path",
            label: `Allow read/write from ${shortDir} ${scopeLabel}`,
            scope,
            rule: rule as PermissionRule,
          });
        }
      }
    }

    const shown = uncovered.slice(0, 3).join(", ");
    const suffix = uncovered.length > 3 ? ", ..." : "";
    return {
      kind: "ask",
      question: `bash writes outside the workspace: ${shown}${suffix}`,
      toolCallId: ctx.toolCallId,
      offers,
      assessment,
    };
  }

  // -- 决策矩阵 -------------------------------------------------

  /**
   * 应用决策矩阵。
   * 权限模式 × 权限类别 → allow 或 ask
   */
  private _applyMatrix(
    mode: PermissionMode,
    assessment: InvocationAssessment,
  ): "allow" | "ask" {
    const cls = assessment.permissionClass;

    // Catastrophic 始终询问，即使在 yolo 中
    if (cls === "catastrophic") return "ask";

    // Read 和 spawn 始终允许
    if (cls === "read" || cls === "spawn") return "allow";

    switch (mode) {
      case "yolo":
        return "allow";

      case "reversible":
        if (cls === "write_reversible") return "allow";
        // 普通 shell 命令自动允许；MCP/未知工具仍按强能力询问。
        if (cls === "write_potent" && (assessment.toolName === "bash" || assessment.toolName === "bash_background")) {
          return "allow";
        }
        return "ask";

      case "read_only":
        return "ask";
    }
  }

  // -- 选项构建 --------------------------------------------------

  /**
   * 为给定评估构建审批选项。
   */
  private _buildOffers(assessment: InvocationAssessment, mode?: PermissionMode): ApprovalOffer[] {
    const offers: ApprovalOffer[] = [];

    // 始终提供 "allow once"
    offers.push({
      type: "tool_once",
      label: "Allow once",
    });

    // read_only：提供模式升级，无持久化规则
    if (mode === "read_only") {
      offers.push({ type: "mode_upgrade", label: "Switch session to reversible and allow" });
      return offers;
    }

    // catastrophic：仅允许一次
    if (assessment.permissionClass === "catastrophic") {
      return offers;
    }

    // 外部 cwd bash：仅允许一次（外部 bash 无持久化规则）
    if (assessment.externalCwd) {
      return offers;
    }

    const scopeLabel = (scope: "session" | "project" | "global"): string =>
      scope === "session" ? "in this session"
        : scope === "project" ? "in this project"
        : "globally";

    // 如果可记忆化，在每个作用域提供 tool_pattern 规则
    if (assessment.canMemoize && assessment.canonicalPattern) {
      const pattern = assessment.canonicalPattern;
      const tool = assessment.toolName;

      for (const scope of ["session", "project", "global"] as const) {
        const rule: Omit<ToolPatternRule, "id" | "createdAt"> = {
          type: "tool_pattern",
          action: "allow",
          tool,
          pattern,
          scope,
        };
        offers.push({
          type: "tool_pattern",
          label: `Always allow "${pattern}" ${scopeLabel(scope)}`,
          scope,
          rule: rule as PermissionRule,
        });
      }
    } else if (assessment.canMemoize) {
      // 无模式但可记忆化（如 write_file, edit_file）
      const tool = assessment.toolName;
      for (const scope of ["session", "project", "global"] as const) {
        const rule: Omit<ToolPatternRule, "id" | "createdAt"> = {
          type: "tool_pattern",
          action: "allow",
          tool,
          scope,
        };
        offers.push({
          type: "tool_pattern",
          label: `Always allow ${tool} ${scopeLabel(scope)}`,
          scope,
          rule: rule as PermissionRule,
        });
      }
    }

    return offers;
  }

  /**
   * 构建询问问题。
   */
  private _buildQuestion(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
  ): string {
    const cls = assessment.permissionClass;

    // Bash：包含命令文本
    if ((ctx.toolName === "bash" || ctx.toolName === "bash_background") && ctx.toolArgs) {
      const command = typeof (ctx.toolArgs as Record<string, unknown>)["command"] === "string"
        ? (ctx.toolArgs as Record<string, unknown>)["command"] as string
        : "";
      if (command) {
        if (cls === "catastrophic") {
          return `DANGEROUS: ${command}`;
        }
        if (assessment.externalCwd) {
          return `bash in external directory ${assessment.externalCwd}: ${command}`;
        }
        return command;
      }
    }

    if (cls === "catastrophic") {
      return `DANGEROUS: ${ctx.toolName} — this operation could cause irreversible damage. ${ctx.summary}`;
    }
    if (cls === "write_danger") {
      return `${ctx.toolName} is a potentially dangerous operation. ${ctx.summary}`;
    }
    return `${ctx.toolName} requires approval. ${ctx.summary}`;
  }
}
