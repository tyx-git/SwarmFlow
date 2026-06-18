/**
 * SwarmFlow -- Public barrel re-exports.
 *
 * Provides a single import point for all public APIs:
 *
 *   import { Session, Agent, Config, SessionStore } from "swarmflow";
 *
 * @packageDocumentation
 */

// -- Config ---------------------------------------------------------------
export {
  Config,
  type ModelConfig,
  type MCPServerConfig,
  type ResolvedPaths,
  getContextLength,
  getMultimodalSupport,
  getThinkingSupport,
  getWebSearchSupport,
  resolveAssetPaths,
  getBundledAssetsDir,
  SWARMFLOW_HOME_DIR,
} from "./config/config.js";

// -- Dotenv ---------------------------------------------------------------
export { loadDotenv, setDotenvKey } from "./lifecycle/dotenv.js";

// -- MCP config -----------------------------------------------------------
export { loadMcpServers } from "./clients/mcp-config.js";

// -- Model discovery ------------------------------------------------------
export { fetchModelsFromServer, type DiscoveredModel } from "./models/discovery.js";

// -- Update check ---------------------------------------------------------
export { checkForUpdates } from "./lifecycle/update-check.js";

// -- Session --------------------------------------------------------------
export { Session } from "./session.js";

// -- Plan state -----------------------------------------------------------
export { parsePlanFile, formatPlanSnapshot, PLAN_FILENAME, type PlanCheckpoint } from "./lib/plan-state.js";

// -- Context rendering ----------------------------------------------------
export {
  COMPACT_MARKER_ROLE,
  CONTEXT_ID_KEY,
  isCompactMarker,
  injectContextIdTag,
  mergeConsecutiveSameRole,
  type CompactMarker,
} from "./context/context-rendering.js";

// -- Agents ---------------------------------------------------------------
export { Agent, type AgentResult, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";

// -- Providers (base types) -----------------------------------------------
export {
  type ImageBlock,
  type ToolDef,
  type ToolCall,
  type Citation,
  ToolResult,
  Usage,
  ProviderResponse,
  BaseProvider,
  type Message,
  type MessageRole,
  type SendMessageOptions,
} from "./providers/base.js";

// -- Primitives -----------------------------------------------------------
export { prompt, context, combine, type MessageBlock } from "./primitives/context.js";

// -- Network retry --------------------------------------------------------
export {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "./lib/network-retry.js";

// -- Progress -------------------------------------------------------------
export {
  type ProgressLevel,
  type ProgressEvent,
  type ProgressCallback,
  ProgressReporter,
  ConsoleProgress,
} from "./lib/progress.js";

// -- Persistence ----------------------------------------------------------
export {
  SessionStore,
} from "./config/persistence.js";

// -- Commands -------------------------------------------------------------
export {
  CommandRegistry,
  type SlashCommand,
  type CommandContext,
  type ShowMessageFn,
  buildDefaultRegistry,
  registerSkillCommands,
} from "./commands/commands.js";

// -- Skills ---------------------------------------------------------------
export {
  loadSkills,
  resolveSkillContent,
  type SkillMeta,
} from "./skills/loader.js";

// -- Templates ------------------------------------------------------------
export {
  loadTemplate,
  loadTemplates,
  assembleSystemPrompt,
  type PromptRecipe,
} from "./templates/loader.js";

// -- Tools ----------------------------------------------------------------
export { BASIC_TOOLS, BASIC_TOOLS_MAP, executeTool } from "./tools/basic.js";
export {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
} from "./tools/comm.js";

// -- Ask protocol ---------------------------------------------------------
export {
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
} from "./ask.js";

// -- File attach ----------------------------------------------------------
export {
  processFileAttachments,
  scanCandidates,
  type FileAttachResult,
  type FileInfo,
} from "./lib/file-attach.js";

// -- TUI ------------------------------------------------------------------
// NOTE: launchTui is provided by external/opentui/main.ts. We no longer re-export
// it from this barrel file because external/opentui lives outside src/'s rootDir.
// Consumers that need to launch the TUI programmatically should import
// directly from the compiled external/opentui entry at runtime.
export type {
  ConversationEntry,
  ConversationEntryKind,
  LaunchOptions,
} from "./ui/contracts.js";

// -- Swarm ---------------------------------------------------------------
export {
  SwarmCoordinator,
  SwarmExecutor,
  AgentPool,
  MessageBus,
  ContextBridge,
  TaskDecomposer,
  SwarmScheduler,
  AgentRole,
  SwarmTopology,
  AgentLifecycle,
  RecoveryStrategy,
  DecompositionStrategy,
  BUILTIN_PATTERNS,
  getPattern,
  listPatterns,
  createDAG,
  validateDAG,
  serializeDAG,
  mergeResults,
  attemptRecovery,
} from "./swarm/__init__.js";
export type {
  SwarmAgentHandle,
  TaskResult,
  ExecutionResult,
  TaskDAG,
  ExecutionPlan,
  SwarmPattern,
  SwarmMessage,
  SwarmSnapshot,
  TaskNode,
} from "./swarm/__init__.js";

// -- Version --------------------------------------------------------------
export { VERSION } from "./version.js";
