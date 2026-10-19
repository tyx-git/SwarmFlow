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
  includeTaskTools: true,
  includeTaskControl: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  // 子会话不能派生执行体、也不能跑后台 shell，因此 await_event 的等待条件
  // （活跃子 agent / 运行中 shell）对它恒不成立——留着只会得到一个立即返回的
  // 空等工具，还会诱发「父等子、子等父」的互等。必须保持 false：子 Session 的
  // 构造函数会用本配置重新追加 comm 工具，一旦为 true，subagent-factory 的
  // COMM_TOOL_NAMES 剥离就会被推翻（tool-runtime.ts 记载的既有陷阱）。
  includeAwaitEventTool: false,
  includeAskTool: false,
  includeSkillTools: false,
  // 子代理自己也要拆分并记录任务（清单为纯内存，随子会话消亡）
  includeTaskTools: true,
  // 但子代理不能派生执行体
  includeTaskControl: false,
};
