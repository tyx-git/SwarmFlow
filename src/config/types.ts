/**
 * 配置层的数据接口：模型配置、UI 展示条目、MCP 服务器连接配置。
 */

import type {
  SealedSchema,
  ThinkingEncryption,
  TransportProtocol,
} from "../thinking/artifact.js";

// ------------------------------------------------------------------

/** 完整的模型配置——包含 API 凭据、能力标志、传输协议等运行时所需全部信息 */
export interface ModelConfig {
  /** 模型配置名称，格式为 "provider:modelKey" */
  name: string;
  /** 服务提供商标识符 */
  provider: string;
  /** 模型 ID（API 请求中的 model 参数） */
  model: string;
  /** API 密钥（可能是明文、环境变量引用 ${ENV}、或 OAuth 标记） */
  apiKey: string;
  /** 自定义 API 基础 URL（可选，为空则使用提供商默认值） */
  baseUrl?: string;
  /** 自定义 provider 标记：true 时，即使 ID 与内置提供商冲突也按协议分派 */
  custom?: boolean;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token 数 */
  maxTokens: number;
  /** 上下文窗口长度（token 数） */
  contextLength: number;
  /** 是否支持多模态输入（图像等） */
  supportsMultimodal: boolean;
  /** 思维链预算（token 数，0 表示不限制） */
  thinkingBudget: number;
  /** 是否支持原生网络搜索 */
  supportsWebSearch: boolean;
  /** 传输协议（chat / responses / anthropic） */
  transportProtocol: TransportProtocol;
  /** 思维链加密方式 */
  thinkingEncryption: ThinkingEncryption;
  /**
   * 密封思维链负载的线格式标签。具有相同标签的两个提供商可以
   * 在彼此之间往返密封推理；null 表示该提供商不发出或接受密封负载。
   */
  sealedSchema: SealedSchema | null;
  /** 未在已知字段中定义的额外配置项 */
  extra: Record<string, unknown>;
}

/** 模型配置的简化条目——用于 UI 展示，不解析 API 密钥 */
export interface ModelConfigEntry {
  /** 模型配置名称 */
  name: string;
  /** 服务提供商 */
  provider: string;
  /** 模型 ID */
  model: string;
  /** 原始 API 密钥值（可能包含 ${ENV} 引用） */
  apiKeyRaw: string;
  /** 该 API 密钥是否可以成功解析（环境变量已设置或 OAuth 令牌存在） */
  hasResolvedApiKey: boolean;
}

/** MCP 服务器配置——定义如何连接和与 MCP 服务器通信 */
export interface MCPServerConfig {
  /** 服务器名称 */
  name: string;
  /** 传输类型：stdio（标准输入输出）或 sse（Server-Sent Events） */
  transport: "stdio" | "sse";
  /** stdio 模式下的启动命令 */
  command: string;
  /** stdio 模式下的命令行参数 */
  args: string[];
  /** SSE 模式下的服务器 URL */
  url: string;
  /** 传递给子进程的环境变量 */
  env: Record<string, string>;
  /** 允许传递的环境变量白名单（可选） */
  envAllowlist?: string[];
  /** 需要用户确认才执行的敏感工具列表（可选） */
  sensitiveTools?: string[];
}
