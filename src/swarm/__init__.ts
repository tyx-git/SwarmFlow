/**
 * SwarmFlow — Multi-agent orchestration system.
 *
 * The swarm module provides the core abstractions for multi-agent
 * coordination: task decomposition, parallel execution, agent communication,
 * and result aggregation.
 *
 * @packageDocumentation
 */

// -- Types ---------------------------------------------------------------
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

// -- Core orchestrator ---------------------------------------------------
export { SwarmCoordinator } from "./coordinator.js";
export type { SwarmCoordinatorOptions, SwarmCoordinatorEvents } from "./coordinator.js";

// -- Agent pool ----------------------------------------------------------
export { AgentPool } from "./pool.js";
export type { AgentPoolConfig } from "./pool.js";

// -- Patterns ------------------------------------------------------------
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

// -- Task DAG ------------------------------------------------------------
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

// -- Decomposer ----------------------------------------------------------
export { TaskDecomposer, DecompositionStrategy, decomposeRequest } from "./decomposer.js";
export type { DecomposerOptions, ProjectContext } from "./decomposer.js";

// -- Scheduler -----------------------------------------------------------
export { SwarmScheduler, scheduleDAG } from "./scheduler.js";
export type { SchedulerConfig, Schedule, TaskEstimate } from "./scheduler.js";

// -- Message Bus ---------------------------------------------------------
export { MessageBus } from "./message-bus.js";
export type { MessageHandler, Subscription, MessageBusConfig } from "./message-bus.js";

// -- Handoff -------------------------------------------------------------
export {
  createHandoffContext,
  formatHandoffPrompt,
  mergeHandoffContexts,
} from "./handoff.js";
export type { HandoffOptions } from "./handoff.js";

// -- Merger --------------------------------------------------------------
export { mergeResults, formatExecutionResult } from "./merger.js";
export type { MergeStrategy, MergeOptions } from "./merger.js";

// -- Context Bridge ------------------------------------------------------
export { ContextBridge, SharedContext, AgentScratchpad } from "./context-bridge.js";
export type { Decision, FileRecord, SharedContextEntry } from "./context-bridge.js";

// -- Recovery ------------------------------------------------------------
export { attemptRecovery, classifyError, getRecoveryConfig, DEFAULT_RECOVERY_CONFIGS } from "./recovery.js";
export type { RecoveryOutcome, RetryFn } from "./recovery.js";

// -- Executor ------------------------------------------------------------
export { SwarmExecutor } from "./executor.js";
export type { ExecutorEvents, SwarmExecutionOptions } from "./executor.js";

// -- Monitor -------------------------------------------------------------
export { SwarmMonitor, formatSwarmSnapshot } from "./monitor.js";
export type { TimelineEvent } from "./monitor.js";
