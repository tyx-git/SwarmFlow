/**
 * 权限规则 — 存储和匹配。
 *
 * 四层规则（最具体优先）：
 *   session    — 仅内存，隨会话结束而消亡
 *   workspace  — {projectRoot}/.swarmflow/permissions.json（用户编写，系统只读）
 *   project    — ~/.swarmflow/projects/<slug>/permissions.json（系统管理）
 *   global     — ~/.swarmflow/permissions.json
 *
 * 规则匹配：拒绝规则优先于允许规则。
 * 在同一操作内，更具体的作用域优先。
 *
 * 系统写入（来自审批选择）写入 project 或 global。
 * Workspace 规则是只读的 — 只有用户可以创建/编辑它们。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { toPosixPath } from "../security/path.js";
import { osCapabilities } from "../platform/index.js";
import type { PermissionRule, PermissionRuleFile, InvocationAssessment, ExternalPathRule } from "./types.js";

// ------------------------------------------------------------------
// PermissionRuleStore — 管理所有层的规则
// ------------------------------------------------------------------

export class PermissionRuleStore {
  /** 会话级规则（仅内存） */
  private _sessionRules: PermissionRule[] = [];
  /** ~/.swarmflow/projects/<slug>/ — 系统管理的项目存储 */
  private _projectStoreDir: string;
  /** {projectRoot} — workspace 根目录（规则只读） */
  private _workspaceRoot: string | undefined;

  constructor(opts: {
    /** 项目存储目录 */
    projectStoreDir: string;
    /** Workspace 根目录（可选） */
    workspaceRoot?: string;
  }) {
    this._projectStoreDir = opts.projectStoreDir;
    this._workspaceRoot = opts.workspaceRoot;
  }

  // -- 查询 ----------------------------------------------------------

  /**
   * 查找第一个匹配的规则。
   * 拒绝规则在允许规则之前检查。
   */
  findMatchingRule(assessment: InvocationAssessment): PermissionRule | null {
    const allRules = this._getEffectiveRules();

    // 先检查拒绝规则
    const denyMatch = allRules.find(
      (r) => r.action === "deny" && this._ruleMatches(r, assessment),
    );
    if (denyMatch) return denyMatch;

    // 允许规则（按最具体优先排序）
    const allowMatch = allRules.find(
      (r) => r.action === "allow" && this._ruleMatches(r, assessment),
    );
    return allowMatch ?? null;
  }

  /**
   * 获取所有有效规则，顺序：session > workspace > project > global。
   */
  private _getEffectiveRules(): PermissionRule[] {
    return [
      ...this._sessionRules,
      ...(this._workspaceRoot ? this._loadFileRules(this._workspaceFilePath()) : []),
      ...this._loadFileRules(this._projectFilePath()),
      ...this._loadFileRules(this._globalFilePath()),
    ];
  }

  /** 获取所有规则（用于显示，如 /permissions list） */
  getAllRules(): PermissionRule[] {
    return this._getEffectiveRules();
  }

  // -- 变更 ----------------------------------------------------------

  /**
   * 添加规则。
   * 防御性规范化：以正斜杠形式存储外部路径前缀，
   * 不论调用者输入如何。advisor.ts 在调用我们之前已经规范化，
   * 但在这里也规范化可以保护任何未来的调用者
   *（手动配置编辑、脚本化规则创建）不会在磁盘上混用反斜杠和正斜杠。
   */
  addRule(rule: Omit<PermissionRule, "id" | "createdAt">): PermissionRule {
    let normalizedRule: Omit<PermissionRule, "id" | "createdAt"> = rule;
    if (rule.type === "external_path") {
      // 在此分支中，`rule` 是区分联合上的辨别窄化，
      // 但 Omit<> 为 TypeScript 的推断丢掉了辨别关联。
      // 两端显式转换。
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

  /**
   * 撤销规则。
   * 返回是否成功撤销。
   */
  revokeRule(ruleId: string): boolean {
    // 会话规则
    const sessionIdx = this._sessionRules.findIndex((r) => r.id === ruleId);
    if (sessionIdx >= 0) {
      this._sessionRules.splice(sessionIdx, 1);
      return true;
    }

    // 文件支持的规则 — 从 ID 前缀确定作用域
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

  /** 清除所有会话级规则 */
  clearSessionRules(): void {
    this._sessionRules = [];
  }

  // -- 外部路径规则 ---------------------------------------------

  /**
   * 查找匹配的外部路径规则。
   * 规则 pathPrefix 和 resolvedPath 都规范化为正斜杠形式。
   * addRule 在写入时也会规范化，所以新存储的规则已使用 `/`；
   * 此读操作上的规范化涵盖任何在 D27 之前混入的 pathPrefix
   * 或通过直接文件编辑的情况。
   *
   * 在不区分大小写的文件系统上（macOS 和 Windows 默认），
   * 同一目录可以用不同大小写解析（`D:\Data` vs `d:\data`），
   * 所以在前缀匹配前折叠大小写 — 否则已批准的位置会重新提示。
   * 无论如何都是故障安全的（不会在区分大小写的 Linux 上扩大匹配）。
   */
  findMatchingExternalPathRule(
    resolvedPath: string,
    accessKind: "read" | "write_reversible",
  ): ExternalPathRule | null {
    const ci = osCapabilities.caseInsensitiveFilesystem;
    const subject = toPosixPath(resolvedPath);
    const subjectCmp = ci ? subject.toLowerCase() : subject;
    const allRules = this._getEffectiveRules();
    for (const rule of allRules) {
      if (rule.type !== "external_path") continue;
      if (rule.action !== "allow") continue;
      if (accessKind === "write_reversible" && rule.accessKind !== "write_reversible") continue;
      const normalized = toPosixPath(rule.pathPrefix);
      // 确保前缀以 / 结尾，防止 /tmp/foo 匹配 /tmp/foobar
      const prefix = normalized.endsWith("/") ? normalized : normalized + "/";
      const prefixCmp = ci ? prefix.toLowerCase() : prefix;
      if (subjectCmp.startsWith(prefixCmp) || subjectCmp === prefixCmp.slice(0, -1)) return rule;
    }
    return null;
  }

  /** 获取所有已批准的外部路径前缀（用于执行器白名单） */
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

  // -- 规则匹配 ---------------------------------------------------

  /**
   * 检查规则是否匹配调用评估。
   */
  private _ruleMatches(rule: PermissionRule, assessment: InvocationAssessment): boolean {
    if (rule.type === "external_path") return false;
    if (rule.tool !== assessment.toolName) return false;

    // 如果规则有模式，匹配规范模式或原始命令
    if (rule.pattern) {
      if (assessment.canonicalPattern) {
        return this._patternMatches(rule.pattern, assessment.canonicalPattern);
      }
      // 无规范模式（复杂命令）— 模式规则不适用
      return false;
    }

    // 未指定模式 — 匹配此工具的所有调用
    return true;
  }

  /**
   * 模式匹配。
   * 支持精确匹配和简单 glob（如 "git *"）。
   */
  private _patternMatches(rulePattern: string, subject: string): boolean {
    // 精确匹配
    if (rulePattern === subject) return true;

    // 简单 glob："git *" 匹配 "git status", "git commit" 等
    if (rulePattern.endsWith(" *")) {
      const prefix = rulePattern.slice(0, -1);
      return subject.startsWith(prefix);
    }

    return false;
  }

  // -- 文件 I/O --------------------------------------------------------

  /** 系统管理的项目规则：~/.swarmflow/projects/<slug>/permissions.json */
  private _projectFilePath(): string {
    return join(this._projectStoreDir, "permissions.json");
  }

  /** 用户编写的 workspace 规则：{projectRoot}/.swarmflow/permissions.json（只读） */
  private _workspaceFilePath(): string {
    return join(this._workspaceRoot!, ".swarmflow", "permissions.json");
  }

  /** 全局规则：~/.swarmflow/permissions.json */
  private _globalFilePath(): string {
    return join(getSwarmflowHomeDir(), "permissions.json");
  }

  /** 从文件加载规则 */
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

  /** 将规则保存到文件（原子写入） */
  private _saveFileRules(filePath: string, rules: PermissionRule[]): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const data: PermissionRuleFile = { version: 1, rules };
    const tmpPath = filePath + ".tmp." + process.pid;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(tmpPath, filePath);
  }

  /** 生成规则 ID */
  private _generateId(scope: "session" | "project" | "global"): string {
    const prefix = scope === "session" ? "s_" : scope === "project" ? "p_" : "g_";
    return prefix + randomUUID().slice(0, 8);
  }
}
