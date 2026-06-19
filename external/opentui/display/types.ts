// =============================================================================
// SwarmFlow GUI — Display 层共享类型
// =============================================================================
// 包含：ActivityPhase、CommandOverlay、PromptSelect、OAuth、Ask 等 UI 状态类型

import type { RefObject } from "react";
import type { InputRenderable } from "@opentui/core";
import type {
  PendingAskUi,
  AgentQuestionItem,
} from "../../src/ask.js";
import type { PromptChoice } from "../../src/provider-credential-flow.js";
import type { OAuthTokens } from "../../src/auth/openai-oauth.js";
import type { GitHubOAuthTokens } from "../../src/auth/github-copilot-oauth.js";

export type OAuthProviderId = "codex" | "copilot";

/** Union of token types the overlay can deliver on success. */
export type AnyOAuthTokens = OAuthTokens | GitHubOAuthTokens;

/** 应用活动阶段（决定 UI 渲染状态）*/
export type ActivityPhase =
  | "idle"      // 空闲，等待输入
  | "Working"   // 处理中
  | "Asking"   // 等待用户审批/回答问题
  | "closing";  // 正在关闭

/** 命令/文件自动补全浮层状态 */
export interface CommandOverlayState {
  mode: "command" | "file";
  visible: boolean;
  items: string[];
  values: string[];
  selected: number;
}

/** 下拉选择器状态（后台 Shell 选择等）*/
export interface PromptSelectState {
  message: string;
  options: PromptChoice[];
  selected: number;
  /**
   * Per-key actions applied to the highlighted option (e.g. x 鈫?stop shell).
   * Keys are plain key names as reported by the keyboard event ("x", "d", 鈥?.
   * Enter/Escape/arrows keep their standard select/cancel/navigate semantics.
   */
  actionKeys?: Record<string, (option: PromptChoice) => void>;
  /** Dim footer line describing the available keys (e.g. "x stop 路 enter open"). */
  footerHint?: string;
}

export interface PromptSecretState {
  message: string;
  allowEmpty: boolean;
}

export type OAuthOverlayPhase =
  | { step: "choose" }
  | { step: "browser_waiting"; url: string }
  | { step: "device_code"; url: string; userCode: string }
  | { step: "polling" }
  | { step: "exchanging" }
  | { step: "done" }
  | { step: "error"; message: string };

export interface OAuthOverlayState {
  /** Which service this overlay is logging in to. */
  provider: OAuthProviderId;
  phase: OAuthOverlayPhase;
  selected: number;
  resolve: (tokens: AnyOAuthTokens | null) => void;
}

export interface QuestionAnswerState {
  optionIndex: number;
  customText?: string;
}

export interface AskPanelProps {
  ask: PendingAskUi;
  error?: string | null;
  selectedIndex: number;
  currentQuestionIndex: number;
  totalQuestions: number;
  questionAnswers: Map<number, QuestionAnswerState>;
  customInputMode: boolean;
  noteInputMode: boolean;
  reviewMode: boolean;
  inlineValue: string;
  optionNotes: Map<string, string>;
  inputRef: RefObject<InputRenderable | null>;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  terminalHeight: number;
  contentWidth: number;
}

export interface AskQuestionState {
  questions: AgentQuestionItem[];
  currentQuestionIndex: number;
}

export const EMPTY_COMMAND_OVERLAY: CommandOverlayState = {
  mode: "command",
  visible: false,
  items: [],
  values: [],
  selected: 0,
};
