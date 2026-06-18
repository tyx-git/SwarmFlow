/**
 * PermissionAdvisor 鈥?the main GateAdvisor that makes allow/ask/deny decisions.
 *
 * Flow:
 *   1. Classify the tool call 鈫?InvocationAssessment
 *   2. External path gate (file tools outside projectRoot)
 *   3. Check persisted rules 鈫?if matching allow, short-circuit allow
 *   4. Apply decision matrix (mode 脳 class 鈫?allow/ask)
 *   5. Build approval offers for ask decisions
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { toPosixPath } from "../security/path.js";
import type { GateAdvisor, GateDecision } from "../lib/tool-runtime.js";
import type { ToolPreflightContext } from "../agents/tool-loop.js";
import { classifyTool, classifyToolAsync } from "./classify.js";
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

// File tools whose `path` argument should be checked for external access
const FILE_TOOLS_WITH_PATH = new Set([
  "read_file", "write_file", "edit_file", "list_dir", "glob", "grep",
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

  /** In-memory "allow once" grants for this session (toolCallId 鈫?true). */
  private _allowOnceGrants = new Set<string>();

  constructor(opts: {
    ruleStore: PermissionRuleStore;
    sessionMode?: PermissionMode;
    agentCeiling?: PermissionMode;
    projectRoot?: string;
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

  // -- GateAdvisor interface -------------------------------------------

  async evaluate(ctx: ToolPreflightContext): Promise<GateDecision> {
    const assessment = await classifyToolAsync(ctx.toolName, ctx.toolArgs, this._projectRoot, this._shellKind);
    const mode = effectiveMode(this._sessionMode, this._agentCeiling);

    // 1. Check allow-once grants
    if (this._allowOnceGrants.has(ctx.toolCallId)) {
      return { kind: "allow" };
    }

    // 2. External path gate for file tools (yolo bypasses)
    if (mode !== "yolo" && FILE_TOOLS_WITH_PATH.has(ctx.toolName)) {
      const externalDecision = this._checkExternalPath(ctx, assessment, mode);
      if (externalDecision) return externalDecision;
    }

    // 3. External cwd gate for bash (skip project rules when in external context)
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

    // 4. Check persisted rules (skip in read_only 鈥?mode is the hard ceiling)
    if (mode !== "read_only") {
      const matchingRule = this._ruleStore.findMatchingRule(assessment);
      if (matchingRule) {
        if (matchingRule.action === "deny") {
          return { kind: "deny", message: `Denied by rule: ${matchingRule.id}` };
        }
        // allow rule 鈥?but catastrophic ALWAYS asks
        if (assessment.permissionClass !== "catastrophic") {
          return { kind: "allow" };
        }
      }
    }

    // 5. Decision matrix
    const decision = this._applyMatrix(mode, assessment);
    if (decision === "allow") {
      return { kind: "allow" };
    }

    // 6. Build approval offers
    const offers = this._buildOffers(assessment, mode);
    return {
      kind: "ask",
      question: this._buildQuestion(ctx, assessment),
      toolCallId: ctx.toolCallId,
      offers,
      assessment,
    };
  }

  // -- Allow-once management -------------------------------------------

  grantAllowOnce(toolCallId: string): void {
    this._allowOnceGrants.add(toolCallId);
  }

  /** Persist a rule from an accepted approval offer. */
  acceptOffer(offer: ApprovalOffer): void {
    if (offer.rule) {
      this._ruleStore.addRule(offer.rule);
    }
  }

  // -- External path checking -----------------------------------------

  private _checkExternalPath(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
    mode: PermissionMode,
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

    // Determine access kind from tool
    const isWrite = ctx.toolName === "write_file" || ctx.toolName === "edit_file";
    const accessKind = isWrite ? "write_reversible" as const : "read" as const;

    // Compute directory prefix: directories use themselves, files use
    // parent. Normalize to forward-slash form so rules created on
    // Windows (where path.resolve returns `\`-separated paths) compare
    // correctly against subsequent invocations via the same matcher.
    const subject = toPosixPath(resolvedPath);
    let dirPrefix: string;
    if (subject.endsWith("/")) {
      dirPrefix = subject;
    } else {
      let isDir = false;
      try { isDir = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory(); } catch { /* ignore */ }
      dirPrefix = isDir ? subject + "/" : toPosixPath(path.dirname(resolvedPath)) + "/";
    }

    // Check existing external path rules
    const matchingRule = this._ruleStore.findMatchingExternalPathRule(resolvedPath, accessKind);
    if (matchingRule) return null; // allowed by rule, continue normal flow

    // Build external path offers 鈥?no "Allow once" (executor needs persistent rule for writes;
    // for reads, session scope is narrow enough). No mode_upgrade (external path rule is the
    // correct mechanism, not mode switching).
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

  // -- Decision matrix -------------------------------------------------

  private _applyMatrix(
    mode: PermissionMode,
    assessment: InvocationAssessment,
  ): "allow" | "ask" {
    const cls = assessment.permissionClass;

    // Catastrophic ALWAYS asks, even in yolo
    if (cls === "catastrophic") return "ask";

    // Read and spawn are always allowed
    if (cls === "read" || cls === "spawn") return "allow";

    switch (mode) {
      case "yolo":
        return "allow";

      case "reversible":
        if (cls === "write_reversible") return "allow";
        return "ask";

      case "read_only":
        return "ask";
    }
  }

  // -- Offer building --------------------------------------------------

  private _buildOffers(assessment: InvocationAssessment, mode?: PermissionMode): ApprovalOffer[] {
    const offers: ApprovalOffer[] = [];

    // Always offer "allow once"
    offers.push({
      type: "tool_once",
      label: "Allow once",
    });

    // read_only: offer mode upgrade, no persistent rules
    if (mode === "read_only") {
      offers.push({ type: "mode_upgrade", label: "Switch session to reversible and allow" });
      return offers;
    }

    // catastrophic: only allow once
    if (assessment.permissionClass === "catastrophic") {
      return offers;
    }

    // External cwd bash: only allow once (no persistent rules for external bash)
    if (assessment.externalCwd) {
      return offers;
    }

    const scopeLabel = (scope: "session" | "project" | "global"): string =>
      scope === "session" ? "in this session"
        : scope === "project" ? "in this project"
        : "globally";

    // If memoizable, offer tool_pattern rules at each scope
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
      // No pattern but memoizable (e.g. write_file, edit_file)
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

  private _buildQuestion(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
  ): string {
    const cls = assessment.permissionClass;

    // Bash: include the command text
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
      return `DANGEROUS: ${ctx.toolName} 鈥?this operation could cause irreversible damage. ${ctx.summary}`;
    }
    if (cls === "write_danger") {
      return `${ctx.toolName} is a potentially dangerous operation. ${ctx.summary}`;
    }
    return `${ctx.toolName} requires approval. ${ctx.summary}`;
  }
}
