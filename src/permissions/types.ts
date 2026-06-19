/**
 * 权限系统类型定义和常量。
 *
 * 三种权限模式控制会话级策略：
 *   read_only    — 仅读工具自动允许
 *   reversible   — 读 + 可逆写自动允许
 *   yolo         — 除灾难性操作外全部自动允许
 *
 * 五种权限类别对每个工具调用进行分类：
 *   read, write_reversible, write_potent, write_danger, catastrophic
 *   （另外有 spawn，始终允许）
 */

// ------------------------------------------------------------------
// 权限模式 — 会话级策略
// ------------------------------------------------------------------

export type PermissionMode = "read_only" | "reversible" | "yolo";

export const PERMISSION_MODE_ORDER: Record<PermissionMode, number> = {
  read_only: 0,
  reversible: 1,
  yolo: 2,
};

/**
 * 获取有效的权限模式。
 * 如果代理上限低于会话模式，则使用代理上限。
 */
export function effectiveMode(sessionMode: PermissionMode, agentCeiling?: PermissionMode): PermissionMode {
  if (!agentCeiling) return sessionMode;
  return PERMISSION_MODE_ORDER[sessionMode] <= PERMISSION_MODE_ORDER[agentCeiling]
    ? sessionMode
    : agentCeiling;
}

// ------------------------------------------------------------------
// 权限类别 — 每次调用的风险级别
// ------------------------------------------------------------------

export type PermissionClass =
  | "read"
  | "spawn"
  | "write_reversible"
  | "write_potent"
  | "write_danger"
  | "catastrophic";

// ------------------------------------------------------------------
// 调用评估 — 工具分类的输出
// ------------------------------------------------------------------

export interface InvocationAssessment {
  /** 权限类别 */
  permissionClass: PermissionClass;
  /** 工具名称 */
  toolName: string;
  /** 对于 bash：解析后的命令名称列表 */
  commands?: string[];
  /** 对于 bash：检测到的路径参数 */
  pathTargets?: string[];
  /** 对于 bash：用于规则匹配的规范模式（如 "npm test"） */
  canonicalPattern?: string;
  /** 工具模式规则是否对此调用有意义 */
  canMemoize?: boolean;
  /** 对于 bash：在项目根目录外时的有效 cwd，完成 cd 解析后设置 */
  externalCwd?: string;
  /** 对于文件工具：位于项目根目录外的解析路径 */
  externalPathPrefix?: string;
}

// ------------------------------------------------------------------
// 决策 — 顾问告诉门控的结果
// ------------------------------------------------------------------

export type AdvisorDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; assessment: InvocationAssessment; offers: ApprovalOffer[] };

// ------------------------------------------------------------------
// 审批选项 — 询问时用户可选择的内容
// ------------------------------------------------------------------

/** 审批选项类型 */
export type ApprovalOfferType = "tool_once" | "tool_pattern" | "external_path" | "mode_upgrade";

export interface ApprovalOffer {
  /** 选项类型 */
  type: ApprovalOfferType;
  /** 显示标签 */
  label: string;
  /** 作用域 */
  scope?: "session" | "project" | "global";
  /** 对于 tool_pattern：如果选择则要持久化的规则 */
  rule?: PermissionRule;
}

// ------------------------------------------------------------------
// 权限规则 — 持久化的允许/拒绝规则
// ------------------------------------------------------------------

/** 工具模式规则 */
export interface ToolPatternRule {
  /** 规则 ID */
  id: string;
  /** 规则类型 */
  type: "tool_pattern";
  /** 操作：允许或拒绝 */
  action: "allow" | "deny";
  /** 工具名称（精确匹配） */
  tool: string;
  /** 对于 bash：命令模式（如 "npm test", "git *"） */
  pattern?: string;
  /** 作用域 */
  scope: "session" | "project" | "global";
  /** 创建时间戳 */
  createdAt: number;
}

/** 外部路径规则 */
export interface ExternalPathRule {
  /** 规则 ID */
  id: string;
  /** 规则类型 */
  type: "external_path";
  /** 操作：仅允许 */
  action: "allow";
  /** 访问类型 */
  accessKind: "read" | "write_reversible";
  /** 目录前缀（解析后的绝对路径） */
  pathPrefix: string;
  /** 作用域 */
  scope: "session" | "project";
  /** 创建时间戳 */
  createdAt: number;
}

/** 权限规则类型联合 */
export type PermissionRule = ToolPatternRule | ExternalPathRule;

/** 权限规则文件格式 */
export interface PermissionRuleFile {
  /** 文件版本 */
  version: 1;
  /** 规则数组 */
  rules: PermissionRule[];
}
