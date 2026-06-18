/**
 * Permission system types and constants.
 *
 * Three permission modes control the session-level policy:
 *   read_only  鈥?only read tools auto-allowed
 *   reversible 鈥?read + reversible write auto-allowed
 *   yolo       鈥?everything auto-allowed except catastrophic
 *
 * Five permission classes categorize each tool invocation:
 *   read, write_reversible, write_potent, write_danger, catastrophic
 *   (plus spawn, which is always allowed)
 */

// ------------------------------------------------------------------
// Permission mode 鈥?session-level policy
// ------------------------------------------------------------------

export type PermissionMode = "read_only" | "reversible" | "yolo";

export const PERMISSION_MODE_ORDER: Record<PermissionMode, number> = {
  read_only: 0,
  reversible: 1,
  yolo: 2,
};

export function effectiveMode(sessionMode: PermissionMode, agentCeiling?: PermissionMode): PermissionMode {
  if (!agentCeiling) return sessionMode;
  return PERMISSION_MODE_ORDER[sessionMode] <= PERMISSION_MODE_ORDER[agentCeiling]
    ? sessionMode
    : agentCeiling;
}

// ------------------------------------------------------------------
// Permission class 鈥?per-invocation risk level
// ------------------------------------------------------------------

export type PermissionClass =
  | "read"
  | "spawn"
  | "write_reversible"
  | "write_potent"
  | "write_danger"
  | "catastrophic";

// ------------------------------------------------------------------
// Invocation assessment 鈥?output of tool classification
// ------------------------------------------------------------------

export interface InvocationAssessment {
  permissionClass: PermissionClass;
  toolName: string;
  /** For bash: the parsed command name(s). */
  commands?: string[];
  /** For bash: detected path arguments. */
  pathTargets?: string[];
  /** For bash: canonical pattern for rule matching (e.g. "npm test"). */
  canonicalPattern?: string;
  /** Whether a tool_pattern rule is meaningful for this invocation. */
  canMemoize?: boolean;
  /** For bash: effective cwd after cd resolution, set when outside projectRoot. */
  externalCwd?: string;
  /** For file tools: resolved path that is outside projectRoot. */
  externalPathPrefix?: string;
}

// ------------------------------------------------------------------
// Decision 鈥?what the advisor tells the gate
// ------------------------------------------------------------------

export type AdvisorDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; assessment: InvocationAssessment; offers: ApprovalOffer[] };

// ------------------------------------------------------------------
// Approval offers 鈥?what the user can choose when asked
// ------------------------------------------------------------------

export type ApprovalOfferType = "tool_once" | "tool_pattern" | "external_path" | "mode_upgrade";

export interface ApprovalOffer {
  type: ApprovalOfferType;
  label: string;
  scope?: "session" | "project" | "global";
  /** For tool_pattern: the rule to persist if chosen. */
  rule?: PermissionRule;
}

// ------------------------------------------------------------------
// Permission rules 鈥?persisted allow/deny rules
// ------------------------------------------------------------------

export interface ToolPatternRule {
  id: string;
  type: "tool_pattern";
  action: "allow" | "deny";
  /** Tool name (exact match). */
  tool: string;
  /** For bash: command pattern (e.g. "npm test", "git *"). */
  pattern?: string;
  scope: "session" | "project" | "global";
  createdAt: number;
}

export interface ExternalPathRule {
  id: string;
  type: "external_path";
  action: "allow";
  accessKind: "read" | "write_reversible";
  /** Directory prefix (resolved absolute path). */
  pathPrefix: string;
  scope: "session" | "project";
  createdAt: number;
}

export type PermissionRule = ToolPatternRule | ExternalPathRule;

export interface PermissionRuleFile {
  version: 1;
  rules: PermissionRule[];
}
