/**
 * 会话能力配置。
 *
 * 定义根会话和子会话各自支持哪些工具和功能。
 */

/** 会话能力接口——标识支持的工具和功能。 */
export interface SessionCapabilities {
  includeSpawnTool: boolean;
  includeKillTool: boolean;
  includeCheckStatusTool: boolean;
  includeAwaitEventTool: boolean;
  includeAskTool: boolean;
  includeSkillTools: boolean;
  includeReloadTool: boolean;
  /** 任务清单工具（task_create / task_list / task_get / task_update）：主、子会话都可持有。 */
  includeTaskTools: boolean;
  /** 任务控制工具（task_resume，`task_execute` 落地后并入）：只有主会话可持有。 */
  includeTaskControl: boolean;
}

export const ROOT_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: true,
  includeKillTool: true,
  includeCheckStatusTool: true,
  includeAwaitEventTool: true,
  includeAskTool: true,
  includeSkillTools: true,
  includeReloadTool: true,
  includeTaskTools: true,
  includeTaskControl: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  includeAwaitEventTool: true,
  includeAskTool: false,
  includeSkillTools: false,
  includeReloadTool: false,
  // 子代理自己也要拆分并记录任务（清单为纯内存，随子会话消亡）
  includeTaskTools: true,
  // 但子代理不能派生执行体
  includeTaskControl: false,
};
