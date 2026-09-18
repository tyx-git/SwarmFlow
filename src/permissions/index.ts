/**
 * 权限系统导出。
 *
 * 提供工具分类、规则存储和权限决策的核心功能。
 */

export { classifyTool, classifyToolAsync, initBashParser } from "./classify.js";
export { PermissionRuleStore } from "./rules.js";
export { PermissionAdvisor } from "./advisor.js";
export { resolveCdContextParsed } from "./cd-context.js";
export type {
  PermissionMode,
  PermissionClass,
  PermissionRule,
  ToolPatternRule,
  ExternalPathRule,
  PermissionRuleFile,
  InvocationAssessment,
  AdvisorDecision,
  ApprovalOffer,
  ApprovalOfferType,
} from "./types.js";
export { effectiveMode, PERMISSION_MODE_ORDER } from "./types.js";
