/**
 * SwarmFlow core type definitions.
 *
 * The swarm system enables multi-agent orchestration: task decomposition,
 * parallel execution, agent communication, and result aggregation.
 *
 * @packageDocumentation
 */

// ------------------------------------------------------------------
// Agent roles
// ------------------------------------------------------------------

/** Agent role within the swarm. */
export enum AgentRole {
  /** Orchestrator — decomposes tasks and coordinates workers. Only one active. */
  Queen = "queen",
  /** Read-only explorer — investigates codebase, searches, reads files. */
  Scout = "scout",
  /** Full-access executor — implements changes, runs tests, fixes bugs. */
  Worker = "worker",
  /** Code reviewer — reviews changes, identifies issues, suggests improvements. */
  Reviewer = "reviewer",
  /** Safety guard — validates changes don't break security/permission rules. */
  Guard = "guard",
  /** Result synthesizer — combines outputs from multiple agents, resolves conflicts. */
  Merger = "merger",
}

/** Human-readable labels for each role. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  [AgentRole.Queen]: "Queen",
  [AgentRole.Scout]: "Scout",
  [AgentRole.Worker]: "Worker",
  [AgentRole.Reviewer]: "Reviewer",
  [AgentRole.Guard]: "Guard",
  [AgentRole.Merger]: "Merger",
};

// ------------------------------------------------------------------
// Swarm topology
// ------------------------------------------------------------------

/** Communication topology for the swarm. */
export enum SwarmTopology {
  /** Queen directly manages all workers (simple delegation). */
  Star = "star",
  /** Pipeline: Scout → Worker → Reviewer → Guard. */
  Chain = "chain",
  /** Fully connected: any agent can communicate with any other. */
  Mesh = "mesh",
  /** Hierarchical: Queen → Sub-Queens → Workers (for large swarms). */
  Hierarchical = "hierarchical",
}

// ------------------------------------------------------------------
// Agent lifecycle
// ------------------------------------------------------------------

/** Fine-grained lifecycle states for a swarm agent. */
export enum AgentLifecycle {
  /** Agent is alive but idle. */
  Idle = "idle",
  /** Agent is thinking / generating. */
  Thinking = "thinking",
  /** Agent is executing tool calls. */
  ToolCalling = "tool_calling",
  /** Agent is generating text output. */
  Generating = "generating",
  /** Agent is blocked waiting for user approval or input. */
  Blocked = "blocked",
  /** Agent encountered an error. */
  Error = "error",
  /** Agent has completed its task successfully. */
  Completed = "completed",
  /** Agent was cancelled. */
  Cancelled = "cancelled",
}

// ------------------------------------------------------------------
// Message types for agent-to-agent communication
// ------------------------------------------------------------------

/** Message types on the swarm message bus. */
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

/** A message exchanged between swarm agents. */
export interface SwarmMessage {
  /** Unique message ID. */
  id: string;
  /** Message type. */
  type: MessageType;
  /** Sender agent ID. */
  sender: string;
  /** Recipient agent ID (undefined = broadcast). */
  recipient?: string;
  /** Topic for pub/sub routing. */
  topic?: string;
  /** Arbitrary payload. */
  payload: unknown;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Time-to-live in milliseconds. */
  ttl: number;
}

// ------------------------------------------------------------------
// Task DAG
// ------------------------------------------------------------------

/** A single node in the task DAG. */
export interface TaskNode {
  /** Unique task ID. */
  id: string;
  /** Required agent role for this task. */
  role: AgentRole;
  /** Human-readable task description. */
  description: string;
  /** IDs of tasks that must complete before this one starts. */
  dependencies: string[];
  /** Template name for agent creation (optional). */
  template?: string;
  /** Priority: 1 (critical), 2 (normal), 3 (background). */
  priority: 1 | 2 | 3;
  /** Task timeout in milliseconds. */
  timeoutMs?: number;
  /** Custom system prompt additions (optional). */
  instructions?: string;
}

/** A directed acyclic graph of tasks. */
export interface TaskDAG {
  /** All task nodes, keyed by ID. */
  nodes: Map<string, TaskNode>;
  /** Entry-point task IDs (no dependencies). */
  entryPoints: string[];
}

// ------------------------------------------------------------------
// Execution plan
// ------------------------------------------------------------------

/** A single execution level — all tasks at this level can run in parallel. */
export interface ExecutionLevel {
  /** Level index (0 = first). */
  index: number;
  /** Task IDs in this level. */
  taskIds: string[];
}

/** The complete execution plan derived from a TaskDAG. */
export interface ExecutionPlan {
  /** All levels, ordered by execution order. */
  levels: ExecutionLevel[];
  /** Total estimated complexity (1-10). */
  complexity: number;
}

// ------------------------------------------------------------------
// Agent handle
// ------------------------------------------------------------------

/** Runtime handle for a swarm agent instance. */
export interface SwarmAgentHandle {
  /** Unique agent instance ID. */
  id: string;
  /** Agent role. */
  role: AgentRole;
  /** Current lifecycle state. */
  lifecycle: AgentLifecycle;
  /** Assigned task IDs. */
  taskIds: string[];
  /** Timestamp when this agent was created. */
  createdAt: number;
  /** Timestamp of last activity. */
  lastActiveAt: number;
  /** Accumulated token usage. */
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** Error message if lifecycle === Error. */
  error?: string;
}

// ------------------------------------------------------------------
// Task result
// ------------------------------------------------------------------

/** Result from a single task execution. */
export interface TaskResult {
  /** Task ID. */
  taskId: string;
  /** Agent ID that executed the task. */
  agentId: string;
  /** Whether the task succeeded. */
  success: boolean;
  /** Output text. */
  output: string;
  /** Files modified (for worker tasks). */
  modifiedFiles?: string[];
  /** Token usage. */
  usage: { inputTokens: number; outputTokens: number };
  /** Error message if !success. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

// ------------------------------------------------------------------
// Execution result
// ------------------------------------------------------------------

/** Final aggregated result of a full execution plan. */
export interface ExecutionResult {
  /** All task results, keyed by task ID. */
  results: Map<string, TaskResult>;
  /** Whether the overall execution succeeded. */
  success: boolean;
  /** Aggregated token usage. */
  totalUsage: { inputTokens: number; outputTokens: number };
  /** Total duration in milliseconds. */
  totalDurationMs: number;
  /** IDs of failed tasks. */
  failedTaskIds: string[];
  /** Summary text for the user. */
  summary: string;
}

// ------------------------------------------------------------------
// Handoff context
// ------------------------------------------------------------------

/** Context passed from one agent to another during handoff. */
export interface HandoffContext {
  /** Source agent ID. */
  fromAgent: string;
  /** Target agent ID. */
  toAgent: string;
  /** Completed tasks so far. */
  completedTasks: TaskResult[];
  /** Shared context: decisions, findings, issues. */
  sharedContext: {
    filesRead: string[];
    decisions: Array<{ subject: string; decision: string }>;
    keyFindings: string[];
    remainingIssues: string[];
  };
  /** Pending to-do items. */
  pendingTodos: Array<{ id: string; description: string }>;
  /** Workspace state. */
  workspaceSnapshot: {
    modifiedFiles: string[];
    createdFiles: string[];
    deletedFiles: string[];
  };
}

// ------------------------------------------------------------------
// Swarm snapshot (for monitoring)
// ------------------------------------------------------------------

/** Point-in-time snapshot of the entire swarm. */
export interface SwarmSnapshot {
  /** All active agent handles. */
  agents: SwarmAgentHandle[];
  /** Current topology. */
  topology: SwarmTopology;
  /** Task DAG being executed (if any). */
  dag?: TaskDAG;
  /** Execution plan (if any). */
  plan?: ExecutionPlan;
  /** Completed task results. */
  completedResults: TaskResult[];
  /** Aggregated metrics. */
  metrics: SwarmMetrics;
  /** Timestamp. */
  timestamp: number;
}

/** Aggregated swarm metrics. */
export interface SwarmMetrics {
  /** Total tokens used. */
  totalTokens: number;
  /** Number of tasks completed. */
  tasksCompleted: number;
  /** Number of tasks failed. */
  tasksFailed: number;
  /** Number of tasks still pending. */
  tasksPending: number;
  /** Number of active agents. */
  activeAgents: number;
  /** Total elapsed time in ms. */
  elapsedMs: number;
}

// ------------------------------------------------------------------
// Recovery strategies
// ------------------------------------------------------------------

/** Strategy for recovering from a task failure. */
export enum RecoveryStrategy {
  /** Immediate retry, up to maxRetries. */
  Retry = "retry",
  /** Exponential backoff retry. */
  RetryWithBackoff = "retry_with_backoff",
  /** Use a fallback agent (e.g., cheaper model). */
  Fallback = "fallback",
  /** Mark as failed, use partial results. */
  Partial = "partial",
  /** Abort the entire swarm execution. */
  Abort = "abort",
}

/** Configuration for recovery behavior. */
export interface RecoveryConfig {
  /** Primary recovery strategy. */
  strategy: RecoveryStrategy;
  /** Maximum retry attempts. */
  maxRetries: number;
  /** Whether to use a fallback model tier on retry. */
  useFallbackModel: boolean;
}

// ------------------------------------------------------------------
// Orchestration patterns
// ------------------------------------------------------------------

/** Pre-defined orchestration pattern specification. */
export interface SwarmPattern {
  /** Pattern name. */
  name: string;
  /** Pattern description. */
  description: string;
  /** Communication topology. */
  topology: SwarmTopology;
  /** Stage definitions in execution order. */
  stages: SwarmStage[];
}

/** A single stage in an orchestration pattern. */
export interface SwarmStage {
  /** Agent role for this stage. */
  role: AgentRole;
  /** Number of parallel agents of this role. */
  count: number;
  /** Stage description / goal. */
  description: string;
  /** For worker stages: how to partition work ('auto' | 'manual'). */
  partitionStrategy?: "auto" | "manual";
  /** For merger stages: how to merge results. */
  mergeStrategy?: "concatenate" | "vote" | "synthesize" | "resolve_conflicts";
}
