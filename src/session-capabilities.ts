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
  /**
   * 终止后台 shell（kill_shell）。Worker 也可能通过同步 bash 超时获得后台
   * shell，因此需要自己终止，避免留下无人管理的进程。
   */
  includeKillShellTool: boolean;
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
  includeKillShellTool: true,
  includeAskTool: true,
  includeSkillTools: true,
  includeTaskTools: true,
  includeTaskControl: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  // Worker 的同步 bash 超时后会得到自己的后台 shell，await_event 用于等待
  // 该 shell 退出；子会话不能 spawn，因此不会出现「父等子、子等父」的互等。
  // 注意：COMM_TOOL_NAMES 也必须移除 await_event，否则剥离会先于能力追加发生。
  includeAwaitEventTool: true,
  // 与 await_event 配套：Worker 必须能终止自己 adopt 的 shell，否则命令卡死时
  // 只能读日志，无法清理后台进程。
  includeKillShellTool: true,
  includeAskTool: false,
  includeSkillTools: false,
  // 子代理自己也要拆分并记录任务（清单为纯内存，随子会话消亡）
  includeTaskTools: true,
  // 但子代理不能派生执行体
  includeTaskControl: false,
};
