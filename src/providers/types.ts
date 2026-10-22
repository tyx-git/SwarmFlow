/** provider 抽象层的消息、工具定义与发送选项类型契约。 */

/** 多模态消息的图像内容块。 */
export interface ImageBlock {
  mediaType: string;   // 例如 "image/png", "image/jpeg"
  data: string;        // base64 编码的图像数据
}

/** 模型返回的单个工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  parseError: string | null;
}

/** 标准化的网页搜索引用。 */
export interface Citation {
  url: string;
  title: string;
  citedText?: string;
}

/** 提供者无关的工具定义。 */
export type ToolTuiPartialRevealPolicy =
  | "immediate"
  | "closed"
  | { completeArgs: string[] };

export interface ToolTuiPolicy {
  /**
   * 部分工具调用何时有资格渲染到 TUI。
   * 隐藏/覆盖决策仍可由 Session 在运行时应用。
   */
  partialReveal?: ToolTuiPartialRevealPolicy;
}

export interface ToolDef {
  name: string;
  description: string;
  /** 函数参数的 JSON Schema。 */
  parameters: Record<string, unknown>;
  /**
   * 工具调用单行摘要的格式字符串。
   * `{agent}` 始终可用；其他占位符映射到参数键。
   */
  summaryTemplate?: string;
  /** 仅本地使用的 TUI 行为提示；永不转发给提供者。 */
  tuiPolicy?: ToolTuiPolicy;
}

// ------------------------------------------------------------------
// 对话消息的消息类型
// ------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool" | "tool_result";

export interface Message {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ------------------------------------------------------------------
// sendMessage 的选项
// ------------------------------------------------------------------

export interface SendMessageOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  /** 当工具调用变得可见且其原始 JSON 参数缓冲区变化时触发。 */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** 当工具调用关闭并由提供者规范化时触发。 */
  onToolCallClosed?: (call: ToolCall) => void;
  signal?: AbortSignal;
  /** 统一思考级别字符串（"off", "low", "medium", "high", "adaptive" 等）。 */
  thinkingLevel?: string;
  /** OpenAI prompt cache affinity 的路由键（例如子 session id）。 */
  promptCacheKey?: string;
}

// ------------------------------------------------------------------
// 带计算属性的类
// ------------------------------------------------------------------
