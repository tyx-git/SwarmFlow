/** 斜杠命令系统的公共类型（命令、选项、执行上下文）。 */

import type { CommandPickerResult } from "../ui/command-picker.js";
import type { CommandPickerPresentation } from "../ui/picker.js";
import type { SessionStore } from "../config/session-store.js";

import { type PromptSecretRequest, type PromptSelectRequest } from "../providers/credential-flow.js";

import { CommandRegistry } from "./registry.js";
import type { SessionLike } from "../session/contract.js";

/**
 * 命令处理程序用来向用户显示消息的回调。
 * 具体实现由 TUI 层提供。
 */
export type ShowMessageFn = (text: string) => void;

/**
 * 传给每个命令处理程序的上下文。
 *
 * 使用通用接口，命令处理程序无需直接导入 TUI。
 */
export interface CommandContext {
  /** 活动会话实例；能力面见 `session/contract.ts`（`Session implements SessionLike`）。 */
  session: SessionLike;

  /* 在对话区域显示消息。 */
  showMessage: ShowMessageFn;

  /** 成功执行切换类命令后回显命令名与参数。 */
  appendSwitchCommandEcho?: (command: string, args: string) => void;

  /**
   * 输入区左下角的简短非持久提示（TUI），用于 "Copied"、
   * "Wait until the agent finishes." 这类不带复制值的确认。
   * 未接线时（如测试、服务模式）回退到 `showMessage`。
   */
  showHint?: (message: string) => void;

  /* 用于持久化的SessionStore（可能未定义）。 */
  store?: SessionStore;

  /* Swarmflow主目录覆盖，用于测试以避免实际用户配置。 */
  swarmflowHomeDir?: string;

  /* 自动保存当前会话（TUI提供实现）。 */
  autoSave: () => void;

  /* 重置TUI状态（取消工作，清除旋转器等）。 */
  resetUiState: () => void;

  /**
   * 强制下一次渲染为全量重绘（TUI 提供实现）。
   * 用于会话恢复之后：从零重建物理终端，而不是基于可能已漂移的状态做增量 diff。
   */
  requestFullRepaint?: () => void;

  /* 用新启动的会话替换活动UI运行时。 */
  restartRuntimeForNewSession?: () => Promise<void>;

  /* 命令注册表本身，因此/help可以枚举命令。 */
  commandRegistry: CommandRegistry;

  /* 注入内容作为用户消息并触发新回合。 */
  onTurnRequested?: (content: string) => void;

  /**
   * 注入一个回合：用户看到 `displayText`，模型收到 `content`。
   * /review 与技能命令借此在向模型发送详细提示词的同时保持对话干净。
   */
  onInjectedTurnRequested?: (displayText: string, content: string) => void;

  /* 通过TUI执行管道触发手动压缩请求。 */
  onManualCompactRequested?: (instruction: string) => void;

  /* 打开后台shell选择器（badge / /shell命令）。 */
  onShellsRequested?: () => void;

  /* 当代理正在为当前回合产生输出时为True。 */
  isProcessing?: () => boolean;

  /* 在命令执行期间提示用户选择一个选项。 */
  promptSelect?: (request: PromptSelectRequest) => Promise<string | undefined>;

  /* 在命令执行期间提示用户输入一个秘密值。 */
  promptSecret?: (request: PromptSecretRequest) => Promise<string | undefined>;

  /**
   * 显示分层命令选择器（支持逐级下钻子项）。
   * 返回选中的叶子值（及可选备注）；取消时返回 undefined。
   */
  promptCommandPicker?: (
    options: CommandOption[],
    config?: CommandPickerPresentation,
  ) => Promise<CommandPickerResult | undefined>;

  /**
   * 为指定 provider 显示内联 OAuth 登录浮层，完成后返回
   * （成功时解析值非 null，取消时为 null）。
   * 返回的 token 类型随 provider 而异；调用方通常只关心它非 null。
   */
  requestOAuthLogin?: (
    provider: "codex" | "copilot",
  ) => Promise<unknown | null>;
}

/**
 * 命令浮层中的一个选项条目。
 */
export type SemanticColor = "success" | "error" | "muted";

export interface CommandOption {
  /* 显示在统一选择器中的标签。 */
  label: string;
  /** 渲染在弹性标签列之前的可选固定文本。 */
  labelPrefix?: string;
  /**
   * 富文本标签分段，每段可单独着色。
   * 存在时标签按彩色分段拼接渲染，不再使用纯字符串；
   * `label` 仍用于搜索与回退。
   */
  labelParts?: Array<{ text: string; color?: SemanticColor }>;
  /* 选择时作为命令参数提交的值。 */
  value: string;
  /* 在标签旁边显示右对齐的细节文本（例如，"+42 -18"）。 */
  detail?: string;
  /* 详细文本中主要图标的语义颜色。 */
  detailColor?: SemanticColor;
  /* 用于标题或通知的不可提交行。 */
  disabled?: boolean;
  /* 分层选择的子选项（例如，提供者→模型）。 */
  children?: CommandOption[];
  /* 当为true时，Enter打开一个内联文本输入，而不是立即提交。 */
  customInput?: boolean;
  /* 内联文本输入框上方的标签。 */
  inputLabel?: string;
  /* 内联文本输入框中的占位符。 */
  inputPlaceholder?: string;
}

/* 为斜杠命令构建动态选择器选项时可用的上下文。 */
export interface CommandOptionsContext {
  session: SessionLike;
  store?: SessionStore;
  /** UI 提供时生效的全局 SwarmFlow 目录。 */
  swarmflowHomeDir?: string;
}

/**
 * 单条斜杠命令。
 */
export interface SlashCommand {
  /* 命令名，例如 "/provider"。 */
  name: string;
  /* /help 中显示的简短描述。 */
  description: string;
  /* 命令运行时调用的异步处理程序。 */
  handler: (ctx: CommandContext, args: string) => Promise<void>;
  /**
   * 可选回调，返回该命令的动态选择器选项。
   * 接收 session/store 上下文，以便计算当前选项。
   */
  options?: (ctx: CommandOptionsContext) => CommandOption[];
  /* 在搜索过程中也匹配的备选名称。 */
  aliases?: string[];
  /* /help分类显示。 */
  category?: CommandCategory;
  /** 命令自带选择器共用的展示契约。 */
  picker?: CommandPickerPresentation;
  /** 处理程序自行接管多步选择流程，而不是把某个选项当命令提交。 */
  pickerFlow?: "handler";
  /** 命令分流：查看类命令始终直达；部分命令在工作中直达或等工作结束后执行。 */
  executionMode?: "always" | "whenBusy" | "queued";
}

export type CommandCategory = "Session" | "Context" | "Workflow" | "Document Processing" | "Provider and Model" | "Ecosystem" | "Project Configuration" | "User Custom" | "UI";
