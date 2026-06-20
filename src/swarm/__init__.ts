/**
 * SwarmFlow — 多智能体编排系统。
 *
 * swarm 模块提供了多智能体协调的核心抽象：任务分解、并行执行、
 * 智能体通信和结果聚合。
 *
 * @packageDocumentation
 */

// -- 类型 ---------------------------------------------------------------
export {
  AgentRole,
  SwarmTopology,
  AgentLifecycle,
  MessageType,
  RecoveryStrategy,
  AGENT_ROLE_LABELS,
} from "./types.js";
export type {
  SwarmMessage,
  TaskNode,
  TaskDAG,
  ExecutionLevel,
  ExecutionPlan,
  SwarmAgentHandle,
  TaskResult,
  ExecutionResult,
  HandoffContext,
  SwarmSnapshot,
  SwarmMetrics,
  RecoveryConfig,
  SwarmPattern,
  SwarmStage,
} from "./types.js";

// -- 核心编排器 -----------------------------------------------------------
export { SwarmCoordinator } from "./coordinator.js";
export type { SwarmCoordinatorOptions, SwarmCoordinatorEvents } from "./coordinator.js";

// -- 智能体池 ----------------------------------------------------------
export { AgentPool } from "./pool.js";
export type { AgentPoolConfig } from "./pool.js";

// -- 模式 ------------------------------------------------------------
export {
  FAN_OUT_FAN_IN,
  PIPELINE,
  ENSEMBLE,
  DEBATE,
  EXPLORATORY,
  BUILTIN_PATTERNS,
  getPattern,
  listPatterns,
} from "./patterns.js";

// -- 任务 DAG ------------------------------------------------------------
export {
  createDAG,
  singleTaskDAG,
  validateDAG,
  hasCycle,
  topologicalSort,
  getLevels,
  addNode,
  removeNode,
  serializeDAG,
  estimateRounds,
} from "./task-dag.js";
export type { ValidationResult, TaskDAGOptions } from "./task-dag.js";

// -- 分解器 ----------------------------------------------------------
export { TaskDecomposer, DecompositionStrategy, decomposeRequest } from "./decomposer.js";
export type { DecomposerOptions, ProjectContext } from "./decomposer.js";

// -- 调度器 -----------------------------------------------------------
export { SwarmScheduler, scheduleDAG } from "./scheduler.js";
export type { SchedulerConfig, Schedule, TaskEstimate } from "./scheduler.js";

// -- 消息总线 ---------------------------------------------------------
export { MessageBus } from "./message-bus.js";
export type { MessageHandler, Subscription, MessageBusConfig } from "./message-bus.js";

// -- 交接 -------------------------------------------------------------
export {
  createHandoffContext,
  formatHandoffPrompt,
  mergeHandoffContexts,
} from "./handoff.js";
export type { HandoffOptions } from "./handoff.js";

// -- 合并器 --------------------------------------------------------------
export { mergeResults, formatExecutionResult } from "./merger.js";
export type { MergeStrategy, MergeOptions } from "./merger.js";

// -- 上下文桥接器 ------------------------------------------------------
export { ContextBridge, SharedContext, AgentScratchpad } from "./context-bridge.js";
export type { Decision, FileRecord, SharedContextEntry } from "./context-bridge.js";

// -- 恢复 ------------------------------------------------------------
export { attemptRecovery, classifyError, getRecoveryConfig, DEFAULT_RECOVERY_CONFIGS } from "./recovery.js";
export type { RecoveryOutcome, RetryFn } from "./recovery.js";

// -- 执行器 ------------------------------------------------------------
export { SwarmExecutor } from "./executor.js";
export type { ExecutorEvents, SwarmExecutionOptions } from "./executor.js";

// -- 监视器 -------------------------------------------------------------
export { SwarmMonitor, formatSwarmSnapshot } from "./monitor.js";
export type { TimelineEvent } from "./monitor.js";