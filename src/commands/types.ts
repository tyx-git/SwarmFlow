/** 斜杠命令系统的公共类型（命令、选项、执行上下文）。 */

import type { CommandPickerResult } from "../ui/command-picker.js";
import type { CommandPickerPresentation } from "../ui/picker.js";
import type { SessionStore } from "../config/session-store.js";

import { type PromptSecretRequest, type PromptSelectRequest } from "../providers/credential-flow.js";

import { CommandRegistry } from "./registry.js";

/**
 * Callback used by command handlers to display a message to the user.
 * The TUI layer supplies the concrete implementation.
 */
export type ShowMessageFn = (text: string) => void;

/**
 * Context passed to every command handler.
 *
 * Uses a generic interface so command handlers don't need direct TUI imports.
 */
export interface CommandContext {
  /* 活动会话实例（类型为‘ any ’以避免循环深度）。 */
  session: any;

  /* 在对话区域显示消息。 */
  showMessage: ShowMessageFn;

  /** 成功执行切换类命令后回显命令名与参数。 */
  appendSwitchCommandEcho?: (command: string, args: string) => void;

  /**
   * Brief, non-persistent UI hint shown in the input area's bottom-left
   * corner (TUI) — for short, no-copy-value confirmations like "Copied" or
   * "Wait until the agent finishes." Falls back to `showMessage` when not
   * wired (e.g. tests, server mode).
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
   * Force the next render to be a full repaint (TUI provides the impl).
   * Used after session restore so the physical terminal is re-asserted from
   * scratch instead of incrementally diffed against a possibly-drifted state.
   */
  requestFullRepaint?: () => void;

  /* 用新启动的会话替换活动UI运行时。 */
  restartRuntimeForNewSession?: () => Promise<void>;

  /* 命令注册表本身，因此/help可以枚举命令。 */
  commandRegistry: CommandRegistry;

  /* 注入内容作为用户消息并触发新回合。 */
  onTurnRequested?: (content: string) => void;

  /**
   * Inject a turn where the user sees `displayText` but the model receives
   * `content`. Used by /review and skill commands to keep the conversation
   * clean while sending detailed prompts to the model.
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
   * Show the hierarchical command picker (with drill-down children support).
   * Returns the selected leaf value (and optional note), or undefined if cancelled.
   */
  promptCommandPicker?: (
    options: CommandOption[],
    config?: CommandPickerPresentation,
  ) => Promise<CommandPickerResult | undefined>;

  /**
   * Show the inline OAuth login overlay for the given provider and return
   * on completion (resolved value is non-null on success, null on cancel).
   * The returned token type varies by provider; callers typically only care
   * that it's non-null.
   */
  requestOAuthLogin?: (
    provider: "codex" | "copilot",
  ) => Promise<unknown | null>;
}

/**
 * An option entry for command overlays.
 */
export type SemanticColor = "success" | "error" | "muted";

export interface CommandOption {
  /* 显示在统一选择器中的标签。 */
  label: string;
  /** Optional fixed text rendered before the flexible label column. */
  labelPrefix?: string;
  /**
   * Rich label segments with optional per-segment color.
   * When present, the label is rendered as concatenated colored segments
   * instead of a plain string. `label` is still used for search/fallback.
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
  /* Label shown above the inline text input. */
  inputLabel?: string;
  /* Placeholder shown in the inline text input. */
  inputPlaceholder?: string;
}

/* 为斜杠命令构建动态选择器选项时可用的上下文。 */
export interface CommandOptionsContext {
  session: any;
  store?: SessionStore;
  /** Active global SwarmFlow directory, when the UI supplies one. */
  swarmflowHomeDir?: string;
}

/**
 * A single slash command.
 */
export interface SlashCommand {
  /* Command name, for example "/provider". */
  name: string;
  /* Short description shown by /help. */
  description: string;
  /* Async handler invoked when the command runs. */
  handler: (ctx: CommandContext, args: string) => Promise<void>;
  /**
   * Optional callback that returns dynamic picker options for this command.
   * Receives session/store context so it can compute the current options.
   */
  options?: (ctx: CommandOptionsContext) => CommandOption[];
  /* 在搜索过程中也匹配的备选名称。 */
  aliases?: string[];
  /* /help分类显示。 */
  category?: CommandCategory;
  /** Shared picker presentation contract for command-owned selectors. */
  picker?: CommandPickerPresentation;
  /** The handler owns a multi-step picker flow instead of submitting an option as a command. */
  pickerFlow?: "handler";
  /** 命令分流：查看类命令始终直达；部分命令在工作中直达或等工作结束后执行。 */
  executionMode?: "always" | "whenBusy" | "queued";
}

export type CommandCategory = "Session" | "Context" | "Workflow" | "Document Processing" | "Provider and Model" | "Ecosystem" | "Project Configuration" | "User Custom" | "UI";
