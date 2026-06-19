/**
 * SwarmFlow 核心类型定义。
 *
 * swarm 系统支持多 agent 编排：任务分解、
 * 并行执行、agent 通信和结果聚合。
 *
 * @packageDocumentation
 */

// ------------------------------------------------------------------
// Agent 角色
// ------------------------------------------------------------------

/** Swarm 中 Agent 的角色。*/
export enum AgentRole {
  /** 编排器 — 分解任务并协调 worker。仅一个活动。*/
  Queen = "queen",
  /** 只读探索者 — 研究代码库、搜索、读取文件。*/
  Scout = "scout",
  /** 完全访问执行器 — 实现更改、运行测试、修复 bug。*/
  Worker = "worker",
  /** 代码审查者 — 审查更改、识别问题、提出改进建议。*/
  Reviewer = "reviewer",
  /** 安全守卫 — 验证更改不破坏安全/权限规则。*/
  Guard = "guard",
  /** 结果综合器 — 组合多个 agent 的输出，解决冲突。*/
  Merger = "merger",
}

/** 每个角色的人类可读标签。*/
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  [AgentRole.Queen]: "Queen",
  [AgentRole.Scout]: "Scout",
  [AgentRole.Worker]: "Worker",
  [AgentRole.Reviewer]: "Reviewer",
  [AgentRole.Guard]: "Guard",
  [AgentRole.Merger]: "Merger",
};

// ------------------------------------------------------------------
// Swarm 拓扑
// ------------------------------------------------------------------

/** Swarm 的通信拓扑。*/
export enum SwarmTopology {
  /** Queen 直接管理所有 worker（简单委托）。*/
  Star = "star",
  /** 管道：Scout → Worker → Reviewer → Guard。*/
  Chain = "chain",
  /** 全连接：任何 agent 可以与任何其他通信。*/
  Mesh = "mesh",
  /** 分层：Queen → Sub-Queens → Workers（用于大型 swarm）。*/
  Hierarchical = "hierarchical",
}

// ------------------------------------------------------------------
// Agent 生命周期
// ------------------------------------------------------------------

/** swarm agent 的细粒度生命周期状态。*/
export enum AgentLifecycle {
  /** Agent 存活但空闲。*/
  Idle = "idle",
  /** Agent 正在思考/生成。*/
  Thinking = "thinking",
  /** Agent 正在执行工具调用。*/
  ToolCalling = "tool_calling",
  /** Agent 正在生成文本输出。*/
  Generating = "generating",
  /** Agent 阻塞等待用户批准或输入。*/
  Blocked = "blocked",
  /** Agent 遇到错误。*/
  Error = "error",
  /** Agent 已成功完成任务。*/
  Completed = "completed",
  /** Agent 被取消。*/
  Cancelled = "cancelled",
}

// ------------------------------------------------------------------
// agent-to-agent 通信的消息类型
// ------------------------------------------------------------------

/** Swarm 消息总线的消息类型。*/
export enum MessageType {
  TaskAssign = "task_assign",
  TaskResult = "task_result",
  StatusUpdate = "status_update",
  Question = "question",
  Answer = "answer",
  Handoff = "handoff",
  LogEntry = "log_entry",
  Heartbeat = "heartbeat",
  Cancel = "cancel",
  Broadcast = "broadcast",
}

/** swarm agent 之间交换的消息。*/
export interface SwarmMessage {
  /** 唯一消息 ID。*/
  id: string;
  /** 消息类型。*/
  type: MessageType;
  /** 发送方 agent ID。*/
  sender: string;
  /** 接收方 agent ID（undefined = 广播）。*/
  recipient?: string;
  /** pub/sub 路由的主题。*/
  topic?: string;
  /** 任意负载。*/
  payload: unknown;
  /** Unix 时间戳（毫秒）。*/
  timestamp: number;
  /** 毫秒为单位的生存时间。*/
  ttl: number;
}

// ------------------------------------------------------------------
// 任务 DAG
// ------------------------------------------------------------------

/** 任务 DAG 中的单个节点。*/
export interface TaskNode {
  /** 唯一任务 ID。*/
  id: string;
  /** 此任务需要的 agent 角色。*/
  role: AgentRole;
  /** 人类可读的任务描述。*/
  description: string;
  /** 此任务开始前必须完成的任务 ID。*/
  dependencies: string[];
  /** agent 创建的模板名称（可选）。*/
  template?: string;
  /** 优先级：1（关键），2（正常），3（后台）。*/
  priority: 1 | 2 | 3;
  /** 任务超时（毫秒）。*/
  timeoutMs?: number;
  /** 自定义 system prompt 添加（可选）。*/
  instructions?: string;
}

/** 任务的有向无环图。*/
export interface TaskDAG {
  /** 所有任务节点，按 ID 键控。*/
  nodes: Map<string, TaskNode>;
  /** 入口点任务 ID（无依赖）。*/
  entryPoints: string[];
}

// ------------------------------------------------------------------
// 执行计划
// ------------------------------------------------------------------

/** 单个执行级别 — 此级别的所有任务可以并行运行。*/
export interface ExecutionLevel {
  /** 级别索引（0 = 第一）。*/
  index: number;
  /** 此级别的任务 ID。 */
  taskIds: string[];
}

/** 从 TaskDAG 导出的完整执行计划。 */
export interface ExecutionPlan {
  /** 所有级别，按执行顺序排列。 */
  levels: ExecutionLevel[];
  /** 总估计复杂度（1-10）。 */
  complexity: number;
}

// ------------------------------------------------------------------
// Agent 句柄
// ------------------------------------------------------------------

/** swarm agent 实例的运行时句柄。 */
export interface SwarmAgentHandle {
  /** 唯一 agent 实例 ID。 */
  id: string;
  /** Agent 角色。 */
  role: AgentRole;
  /** 当前生命周期状态。 */
  lifecycle: AgentLifecycle;
  /** 已分配的任务 ID。 */
  taskIds: string[];
  /** 此 agent 创建时的时间戳。 */
  createdAt: number;
  /** 最后活动时间的时间戳。 */
  lastActiveAt: number;
  /** 累计 token 使用量。 */
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** 如果 lifecycle === Error 时的错误消息。 */
  error?: string;
}

// ------------------------------------------------------------------
// 任务结果
// ------------------------------------------------------------------

/** 单个任务执行的结果。 */
export interface TaskResult {
  /** 任务 ID。 */
  taskId: string;
  /** 执行任务的 Agent ID。 */
  agentId: string;
  /** 任务是否成功。 */
  success: boolean;
  /** 输出文本。 */
  output: string;
  /** 修改的文件（用于 worker 任务）。 */
  modifiedFiles?: string[];
  /** Token 使用量。 */
  usage: { inputTokens: number; outputTokens: number };
  /** 如果 !success 时的错误消息。 */
  error?: string;
  /** 持续时间（毫秒）。 */
  durationMs: number;
}

// ------------------------------------------------------------------
// 执行结果
// ------------------------------------------------------------------

/** 完整执行计划的最终聚合结果。 */
export interface ExecutionResult {
  /** 所有任务结果，按任务 ID 键控。 */
  results: Map<string, TaskResult>;
  /** 整体执行是否成功。 */
  success: boolean;
  /** 聚合的 token 使用量。 */
  totalUsage: { inputTokens: number; outputTokens: number };
  /** 总持续时间（毫秒）。 */
  totalDurationMs: number;
  /** 失败任务的 ID。 */
  failedTaskIds: string[];
  /** 给用户的摘要文本。 */
  summary: string;
}

// ------------------------------------------------------------------
// 交接 context
// ------------------------------------------------------------------

/** 交接期间从一个 agent 传递给另一个 agent 的上下文。 */
export interface HandoffContext {
  /** 源 agent ID。 */
  fromAgent: string;
  /** 目标 agent ID。 */
  toAgent: string;
  /** 到目前为止完成的任务。 */
  completedTasks: TaskResult[];
  /** 共享上下文：决策、发现、问题。 */
  sharedContext: {
    filesRead: string[];
    decisions: Array<{ subject: string; decision: string }>;
    keyFindings: string[];
    remainingIssues: string[];
  };
  /** 待处理的任务项。 */
  pendingTodos: Array<{ id: string; description: string }>;
  /** 工作区状态。 */
  workspaceSnapshot: {
    modifiedFiles: string[];
    createdFiles: string[];
    deletedFiles: string[];
  };
}

// ------------------------------------------------------------------
// Swarm 快照（用于监控）
// ------------------------------------------------------------------

/** 整个 swarm 的时间点快照。 */
export interface SwarmSnapshot {
  /** 所有活动的 agent 句柄。 */
  agents: SwarmAgentHandle[];
  /** 当前拓扑。 */
  topology: SwarmTopology;
  /** 正在执行的 Task DAG（如果有）。 */
  dag?: TaskDAG;
  /** 执行计划（如果有）。 */
  plan?: ExecutionPlan;
  /** 已完成的任务结果。 */
  completedResults: TaskResult[];
  /** 聚合的指标。 */
  metrics: SwarmMetrics;
  /** 时间戳。 */
  timestamp: number;
}

/** 聚合的 swarm 指标。 */
export interface SwarmMetrics {
  /** 使用的总 token 数。 */
  totalTokens: number;
  /** 已完成的任务数。 */
  tasksCompleted: number;
  /** 失败的任务数。 */
  tasksFailed: number;
  /** 仍在等待的任务数。 */
  tasksPending: number;
  /** 活动 agent 的数量。 */
  activeAgents: number;
  /** 总 elapsed 时间（毫秒）。 */
  elapsedMs: number;
}

// ------------------------------------------------------------------
// 恢复策略
// ------------------------------------------------------------------

/** 从任务失败中恢复的策略。 */
export enum RecoveryStrategy {
  /** 立即重试，最多 maxRetries 次。 */
  Retry = "retry",
  /** 指数退避重试。 */
  RetryWithBackoff = "retry_with_backoff",
  /** 使用后备 agent（例如更便宜的模型）。 */
  Fallback = "fallback",
  /** 标记为失败，使用部分结果。 */
  Partial = "partial",
  /** 中止整个 swarm 执行。 */
  Abort = "abort",
}

/** 恢复行为的配置。 */
export interface RecoveryConfig {
  /** 主要恢复策略。 */
  strategy: RecoveryStrategy;
  /** 最大重试次数。 */
  maxRetries: number;
  /** 重试时是否使用后备模型层级。 */
  useFallbackModel: boolean;
}

// ------------------------------------------------------------------
// 编排模式
// ------------------------------------------------------------------

/** 预定义的编排模式规范。 */
export interface SwarmPattern {
  /** 模式名称。 */
  name: string;
  /** 模式描述。 */
  description: string;
  /** 通信拓扑。 */
  topology: SwarmTopology;
  /** 按执行顺序排列的阶段定义。 */
  stages: SwarmStage[];
}

/** 编排模式中的单个阶段。 */
export interface SwarmStage {
  /** 此阶段的 agent 角色。 */
  role: AgentRole;
  /** 此角色的并行 agent 数量。 */
  count: number;
  /** 阶段描述/目标。 */
  description: string;
  /** 对于 worker 阶段：如何划分工作（'auto' | 'manual'）。 */
  partitionStrategy?: "auto" | "manual";
  /** 对于 merger 阶段：如何合并结果。 */
  mergeStrategy?: "concatenate" | "vote" | "synthesize" | "resolve_conflicts";
}
