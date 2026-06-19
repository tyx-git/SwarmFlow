/**
 * SwarmFlow —— 公共 barrel 重导出。
 *
 * 提供单一导入点访问所有公共 API：
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
/** 加载 ~/.swarmflow/.env 到 process.env。 */
export { loadDotenv, setDotenvKey } from "./lifecycle/dotenv.js";

// -- MCP 配置 -----------------------------------------------------------
/** 从配置加载 MCP 服务器列表。 */
export { loadMcpServers } from "./clients/mcp-config.js";

// -- 模型发现 ------------------------------------------------------
/** 从远程服务器发现可用模型。 */
export { fetchModelsFromServer, type DiscoveredModel } from "./models/discovery.js";

// -- 更新检查 ---------------------------------------------------------
/** 检查并下载 SwarmFlow 更新。 */
export { checkForUpdates } from "./lifecycle/update-check.js";

// -- Session --------------------------------------------------------------
/** 核心会话类——管理生命周期、工具执行、子代理。 */
export { Session } from "./session.js";

// -- 计划状态 ---------------------------------------------------------
/** 解析和格式化会话 plan 文件。 */
export { parsePlanFile, formatPlanSnapshot, PLAN_FILENAME, type PlanCheckpoint } from "./lib/plan-state.js";

// -- 上下文渲染 ----------------------------------------------------
/**
 * 上下文压缩相关标记和工具函数。
 * compact_marker 标签用于标识已被压缩的上下文区域。
 */
export {
  COMPACT_MARKER_ROLE,
  CONTEXT_ID_KEY,
  isCompactMarker,
  injectContextIdTag,
  mergeConsecutiveSameRole,
  type CompactMarker,
} from "./context/context-rendering.js";

// -- Agent ---------------------------------------------------------------
/**
 * Agent 核心执行单元。
 * isNoReply / NO_REPLY_MARKER 用于检测蜂群协调信号。
 */
export { Agent, type AgentResult, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";

// -- Provider（基础类型） -----------------------------------------------
/**
 * 所有 Provider 的共同接口和类型。
 * BaseProvider 是每个具体 Provider（Anthropic/OpenAI/DeepSeek 等）的基类。
 */
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

// -- 原语 -----------------------------------------------------------
/** 消息块原语——prompt、context、combine 用于组装系统提示。 */
export { prompt, context, combine, type MessageBlock } from "./primitives/context.js";

// -- 网络重试 --------------------------------------------------------
/**
 * 网络错误重试策略。
 * isRetryableNetworkError 判断是否为可重试错误；
 * retrySleep 是带指数退避的等待。
 */
export {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "./lib/network-retry.js";

// -- 进度报告 ---------------------------------------------------------
/**
 * 进度事件系统。
 * ProgressReporter 用于向 TUI 推送实时进度；
 * ConsoleProgress 是 CLI 模式的控制台实现。
 */
export {
  type ProgressLevel,
  type ProgressEvent,
  type ProgressCallback,
  ProgressReporter,
  ConsoleProgress,
} from "./lib/progress.js";

// -- 持久化 ----------------------------------------------------------
/** SessionStore：会话列表、恢复、持久化。 */
export {
  SessionStore,
} from "./config/persistence.js";

// -- 命令 -------------------------------------------------------------
/**
 * 斜杠命令（/model、/key、/summarize 等）注册表。
 * buildDefaultRegistry 构建默认命令集；
 * registerSkillCommands 将技能加载为命令。
 */
export {
  CommandRegistry,
  type SlashCommand,
  type CommandContext,
  type ShowMessageFn,
  buildDefaultRegistry,
  registerSkillCommands,
} from "./commands/commands.js";

// -- 技能 -----------------------------------------------------------
/**
 * 技能（Skills）加载和解析。
 * 技能是预定义的提示模板，可扩展 Agent 能力。
 */
export {
  loadSkills,
  resolveSkillContent,
  type SkillMeta,
} from "./skills/loader.js";

// -- 模板 ------------------------------------------------------------
/**
 * Agent 模板加载和系统提示组装。
 * 模板定义在 prompts/templates/ 目录。
 */
export {
  loadTemplate,
  loadTemplates,
  assembleSystemPrompt,
  type PromptRecipe,
} from "./templates/loader.js";

// -- 工具 ----------------------------------------------------------------
/**
 * 内置工具集（Bash、Edit、Read、Grep 等）。
 * BASIC_TOOLS_MAP 是工具名到 ToolDef 的映射；
 * executeTool 是工具的默认执行器。
 */
export { BASIC_TOOLS, BASIC_TOOLS_MAP, executeTool } from "./tools/basic.js";

/**
 * Agent 间通信工具：spawn、kill_agent、check_status、await_event、summarize_context、ask。
 * 这些工具用于多智能体蜂群编排。
 */
export {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
} from "./tools/comm.js";

// -- Ask 协议 ---------------------------------------------------------
/**
 * Agent 向用户提问的数据类型（agent_question / approval）。
 * 用于工具执行前的权限审批和多选项询问。
 */
export {
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
} from "./ask.js";

// -- 文件附件 ----------------------------------------------------------
/**
 * 文件附件处理：processFileAttachments 解析用户附带的文件，
 * scanCandidates 扫描目录下可附加的候选文件。
 */
export {
  processFileAttachments,
  scanCandidates,
  type FileAttachResult,
  type FileInfo,
} from "./lib/file-attach.js";

// -- TUI ------------------------------------------------------------------
/**
 * TUI 契约类型：ConversationEntry 是会话条目的类型化表示。
 * 注意：launchTui 已移至 external/opentui/main.ts，
 * 不再从此 barrel 导出，需要时直接从 external/opentui/main.js 导入。
 */
export type {
  ConversationEntry,
  ConversationEntryKind,
  LaunchOptions,
} from "./ui/contracts.js";

// -- Swarm（蜂群编排） -------------------------------------------------
/**
 * 蜂群编排核心类型和函数。
 * SwarmCoordinator：编排多个 Agent 的执行；
 * AgentPool：管理并发 Agent 池；
 * MessageBus：Agent 间消息传递；
 * TaskDecomposer：将任务分解为 DAG；
 * BUILTIN_PATTERNS：五种内置编排模式（扇出/扇入、流水线等）。
 */
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

// -- 版本 --------------------------------------------------------------
/** 当前 SwarmFlow 版本号。 */
export { VERSION } from "./version.js";
