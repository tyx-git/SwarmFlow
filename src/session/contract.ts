/**
 * 会话能力契约：`commands/`、`models/`、`ui/` 实际依赖的那部分 Session 面。
 *
 * 手写接口而不是 `Pick<Session, …>`：`Pick` 只会镜像实现当前的样子，实现侧的
 * 失真会被原样继承（`onMcpStatus` 曾把 `state` 写成 `string` 而非
 * `McpServerState`，正是靠手写契约才纠正）。手写还能声明得比实现更严，靠
 * `Session implements SessionLike` 强制两边收敛——Session 改名/删成员/改签名
 * 时编译直接在 `session.ts` 报错，而不是让调用方静默降级。
 *
 * 另两条取舍：`ui/contracts.Session` 必须能被「非 Session 实例」的渲染实现
 * 满足，不宜绑死具体类。注意这些是取舍而非硬约束——实测 `Pick<Session, keys>`
 * 能编译，且与 `SessionLike` 互相可赋值。
 *
 * 本模块住在 `session/` 而非 `commands/`：`models/` 与会话内部簇都要引用它，
 * 放在命令层会让下层反向依赖上层目录。全部为类型，运行时被擦除。
 */

import type { Agent } from "../agents/agent.js";
import type { MCPClientManager, McpServerStatus } from "../clients/mcp/manager.js";
import type { Config } from "../config/loader.js";
import type { SessionStore } from "../config/session-store.js";
import type { GlobalTuiPreferences } from "../config/settings/legacy-preferences.js";
import type { HookRuntime } from "../hooks/index.js";
import type { PersistedModelSelection } from "../models/selection.js";
import type { PermissionMode } from "../permissions/types.js";
import type { SkillMeta } from "../skills/loader.js";
import type { RewindTargetTurn } from "./rewind/types.js";
import type { ChildSessionSnapshot } from "./tree-types.js";
import type { SubagentSettings } from "./subagent-settings.js";
import type { RewindApplyResult, RewindPlan } from "../ui/contracts.js";

export interface SessionLike {
  /* 会话状态面 */
  config: Config;
  primaryAgent: Agent;
  readonly hookRuntime: HookRuntime;
  readonly currentTurnRunning: boolean;
  permissionMode: PermissionMode;
  thinkingLevel: string;
  readonly skills: ReadonlyMap<string, SkillMeta>;
  readonly skillsDirty: boolean;

  /* 消息与标题回显 */
  appendCommandEcho(
    text: string,
    style: "switch" | "injected",
    tone?: "default" | "worked",
  ): void;
  appendErrorMessage(text: string, errorType?: string): void;
  appendStatusMessage(text: string, statusType?: string, ephemeral?: boolean): void;
  setDisplayCutoff(): void;
  setTitle(title: string): void;
  getDisplayName(): string;
  _resetTransientState(): void;

  /* 模型与偏好 */
  readonly currentModelName: string;
  readonly currentModelConfigName: string;
  switchModel(modelConfigName: string): void;
  reloadCurrentModelConfig(): void;
  setPersistedModelSelection(selection: Partial<PersistedModelSelection>): void;
  getGlobalPreferences(): GlobalTuiPreferences;
  getSubagentSettings(): SubagentSettings | undefined;
  setSubagentSettings(settings: SubagentSettings): void;

  /* 技能 */
  getAllSkillNames(): { name: string; description: string; enabled: boolean }[];
  setSkillEnabled(name: string, enabled: boolean): void;

  /* MCP 与配置重载 */
  readonly mcpManager: MCPClientManager | undefined;
  onMcpStatus?: (statuses: McpServerStatus[]) => void;
  ensureMcpReady(): Promise<void>;
  ensureMcpReadyFromCommand(): Promise<void>;
  reloadMcp(options?: { notice?: boolean; reason?: string }): Promise<string>;
  reloadMcpFromCommand(reason: string): Promise<string>;
  reconnectMcpServer(serverName: string): Promise<boolean>;
  reconnectMcpServerFromCommand(serverName: string): Promise<boolean>;
  reloadConfigurationFromCommand(): Promise<string>;

  /* Rewind */
  getRewindTargets(): RewindTargetTurn[];
  getRewindTargetsAsync?(): Promise<RewindTargetTurn[]>;
  planRewind(fromTurnIndex: number): Promise<RewindPlan>;
  rewindConversation(toTurnIndex: number): { removed: number; error?: string };
  rewindFiles(plan: RewindPlan): Promise<RewindApplyResult>;
  rewindBoth(toTurnIndex: number, plan: RewindPlan): Promise<RewindApplyResult & { removed: number }>;
  finalizeRewindJournal(): void;

  /* 子会话 */
  getChildSessionSnapshots(): ChildSessionSnapshot[];
  killChildSession(childId: string): { accepted: boolean; reason?: string };

  /* 生命周期 */
  resetForNewSession(newStore?: SessionStore): Promise<void>;
}

/** 只做模型名解析的调用方需要的最小面（真实 Session 与 restore host 都满足）。 */
export type ModelResolutionSession = Pick<SessionLike, "config" | "primaryAgent">;

/**
 * 模型/凭据选择器树需要的视图。
 *
 * 独立声明而不是 `Pick<SessionLike, …>`：init 向导在没有 Session 的情况下
 * 自造一个只带 `config` 的对象喂给选择器树（`lifecycle/init-service.ts`），
 * 那里的 `primaryAgent` 不是真的 `Agent` 实例。
 */
export interface ModelPickerSessionView {
  config: Config;
  currentModelConfigName?: string;
  primaryAgent?: {
    modelConfig?: {
      provider?: string;
      model?: string;
      apiKey?: string;
    };
  };
}
