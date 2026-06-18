/**
 * Permission rules 鈥?storage and matching.
 *
 * Four layers (most specific wins):
 *   session   鈥?in-memory only, dies with the session
 *   workspace 鈥?{projectRoot}/.swarmflow/permissions.json (user-authored, read-only by system)
 *   project   鈥?~/.swarmflow/projects/<slug>/permissions.json (system-managed)
 *   global    鈥?~/.swarmflow/permissions.json
 *
 * Rule matching: deny rules take priority over allow rules.
 * Within the same action, more specific scope wins.
 *
 * System writes (from approval choices) go to project or global.
 * Workspace rules are read-only 鈥?only the user creates/edits them.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { toPosixPath } from "../security/path.js";
import { osCapabilities } from "../platform/index.js";
import type { PermissionRule, PermissionRuleFile, InvocationAssessment, ExternalPathRule } from "./types.js";

// ------------------------------------------------------------------
// PermissionRuleStore 鈥?manages rules across all layers
// ------------------------------------------------------------------

export class PermissionRuleStore {
  private _sessionRules: PermissionRule[] = [];
  /** ~/.swarmflow/projects/<slug>/ 鈥?system-managed project store. */
  private _projectStoreDir: string;
  /** {projectRoot} 鈥?workspace root (read-only for rules). */
  private _workspaceRoot: string | undefined;

  constructor(opts: {
    projectStoreDir: string;
    workspaceRoot?: string;
  }) {
    this._projectStoreDir = opts.projectStoreDir;
    this._workspaceRoot = opts.workspaceRoot;
  }

  // -- Query ----------------------------------------------------------

  /** Find the first matching rule. Deny rules are checked before allow rules. */
  findMatchingRule(assessment: InvocationAssessment): PermissionRule | null {
    const allRules = this._getEffectiveRules();

    // Deny rules first
    const denyMatch = allRules.find(
      (r) => r.action === "deny" && this._ruleMatches(r, assessment),
    );
    if (denyMatch) return denyMatch;

    // Allow rules (ordered most-specific first)
    const allowMatch = allRules.find(
      (r) => r.action === "allow" && this._ruleMatches(r, assessment),
    );
    return allowMatch ?? null;
  }

  /** Get all effective rules, ordered: session > workspace > project > global. */
  private _getEffectiveRules(): PermissionRule[] {
    return [
      ...this._sessionRules,
      ...(this._workspaceRoot ? this._loadFileRules(this._workspaceFilePath()) : []),
      ...this._loadFileRules(this._projectFilePath()),
      ...this._loadFileRules(this._globalFilePath()),
    ];
  }

  /** Get all rules for display (e.g. /permissions list). */
  getAllRules(): PermissionRule[] {
    return this._getEffectiveRules();
  }

  // -- Mutations -------------------------------------------------------

  addRule(rule: Omit<PermissionRule, "id" | "createdAt">): PermissionRule {
    // Defensive normalization: store external_path prefixes in
    // forward-slash form regardless of the caller's input. advisor.ts
    // already normalizes before calling us, but normalizing here too
    // protects any future caller (manual config edit, scripted rule
    // creation) from mixing backslashes and forward slashes on disk.
    let normalizedRule: Omit<PermissionRule, "id" | "createdAt"> = rule;
    if (rule.type === "external_path") {
      // Inside this branch `rule` is a discriminated narrow on the
      // union, but Omit<> drops the discriminant correlation for
      // TypeScript's inference. Cast both ends explicitly.
      const external = rule as Omit<ExternalPathRule, "id" | "createdAt">;
      normalizedRule = {
        ...external,
        pathPrefix: toPosixPath(external.pathPrefix),
      } as Omit<PermissionRule, "id" | "createdAt">;
    }
    const full = {
      ...normalizedRule,
      id: this._generateId(normalizedRule.scope),
      createdAt: Date.now(),
    } as PermissionRule;

    if (full.scope === "session") {
      this._sessionRules.push(full);
    } else {
      const filePath = full.scope === "project"
        ? this._projectFilePath()
        : this._globalFilePath();
      const existing = this._loadFileRules(filePath);
      existing.push(full);
      this._saveFileRules(filePath, existing);
    }

    return full;
  }

  revokeRule(ruleId: string): boolean {
    // Session rules
    const sessionIdx = this._sessionRules.findIndex((r) => r.id === ruleId);
    if (sessionIdx >= 0) {
      this._sessionRules.splice(sessionIdx, 1);
      return true;
    }

    // File-backed rules 鈥?determine scope from ID prefix
    const filePath = ruleId.startsWith("p_")
      ? this._projectFilePath()
      : ruleId.startsWith("g_")
        ? this._globalFilePath()
        : null;

    if (!filePath) return false;

    const rules = this._loadFileRules(filePath);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return false;
    rules.splice(idx, 1);
    this._saveFileRules(filePath, rules);
    return true;
  }

  clearSessionRules(): void {
    this._sessionRules = [];
  }

  // -- External path rules ---------------------------------------------

  findMatchingExternalPathRule(
    resolvedPath: string,
    accessKind: "read" | "write_reversible",
  ): ExternalPathRule | null {
    // Both rule.pathPrefix and resolvedPath are normalized to
    // forward-slash form here. addRule normalizes on write too, so
    // freshly stored rules already use `/`; this normalization on
    // read covers any pathPrefix that snuck in pre-D27 or via a
    // direct file edit.
    //
    // On a case-insensitive filesystem (default macOS, Windows) the
    // same directory can be resolved with different casing (`D:\Data`
    // vs `d:\data`, drive-letter case is preserved by path.resolve), so
    // fold case before prefix-matching 鈥?otherwise an already-approved
    // location gets re-prompted. Fail-safe either way (never widens a
    // match on case-sensitive Linux, where casing is significant).
    const ci = osCapabilities.caseInsensitiveFilesystem;
    const subject = toPosixPath(resolvedPath);
    const subjectCmp = ci ? subject.toLowerCase() : subject;
    const allRules = this._getEffectiveRules();
    for (const rule of allRules) {
      if (rule.type !== "external_path") continue;
      if (rule.action !== "allow") continue;
      if (accessKind === "write_reversible" && rule.accessKind !== "write_reversible") continue;
      const normalized = toPosixPath(rule.pathPrefix);
      // Ensure prefix ends with / to prevent /tmp/foo matching /tmp/foobar
      const prefix = normalized.endsWith("/") ? normalized : normalized + "/";
      const prefixCmp = ci ? prefix.toLowerCase() : prefix;
      if (subjectCmp.startsWith(prefixCmp) || subjectCmp === prefixCmp.slice(0, -1)) return rule;
    }
    return null;
  }

  /** Get all approved external path prefixes (for executor allowlist). */
  getApprovedExternalPrefixes(): string[] {
    const allRules = this._getEffectiveRules();
    const prefixes: string[] = [];
    for (const rule of allRules) {
      if (rule.type !== "external_path") continue;
      if (rule.action !== "allow") continue;
      const normalized = toPosixPath(rule.pathPrefix);
      prefixes.push(normalized.endsWith("/") ? normalized : normalized + "/");
    }
    return prefixes;
  }

  // -- Rule matching ---------------------------------------------------

  private _ruleMatches(rule: PermissionRule, assessment: InvocationAssessment): boolean {
    if (rule.type === "external_path") return false;
    if (rule.tool !== assessment.toolName) return false;

    // If rule has a pattern, match against canonical pattern or raw commands
    if (rule.pattern) {
      if (assessment.canonicalPattern) {
        return this._patternMatches(rule.pattern, assessment.canonicalPattern);
      }
      // No canonical pattern (complex command) 鈥?pattern rules don't apply
      return false;
    }

    // No pattern specified 鈥?matches all invocations of this tool
    return true;
  }

  private _patternMatches(rulePattern: string, subject: string): boolean {
    // Exact match
    if (rulePattern === subject) return true;

    // Simple glob: "git *" matches "git status", "git commit", etc.
    if (rulePattern.endsWith(" *")) {
      const prefix = rulePattern.slice(0, -1); // "git "
      return subject.startsWith(prefix);
    }

    return false;
  }

  // -- File I/O --------------------------------------------------------

  /** System-managed project rules: ~/.swarmflow/projects/<slug>/permissions.json */
  private _projectFilePath(): string {
    return join(this._projectStoreDir, "permissions.json");
  }

  /** User-authored workspace rules: {projectRoot}/.swarmflow/permissions.json (read-only) */
  private _workspaceFilePath(): string {
    return join(this._workspaceRoot!, ".swarmflow", "permissions.json");
  }

  private _globalFilePath(): string {
    return join(getSwarmflowHomeDir(), "permissions.json");
  }

  private _loadFileRules(filePath: string): PermissionRule[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as PermissionRuleFile;
      if (raw.version !== 1 || !Array.isArray(raw.rules)) return [];
      return raw.rules;
    } catch {
      return [];
    }
  }

  private _saveFileRules(filePath: string, rules: PermissionRule[]): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const data: PermissionRuleFile = { version: 1, rules };
    const tmpPath = filePath + ".tmp." + process.pid;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(tmpPath, filePath);
  }

  private _generateId(scope: "session" | "project" | "global"): string {
    const prefix = scope === "session" ? "s_" : scope === "project" ? "p_" : "g_";
    return prefix + randomUUID().slice(0, 8);
  }
}
