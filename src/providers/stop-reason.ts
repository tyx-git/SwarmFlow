/** 各家 provider 终止原因的归一化词汇与映射表。 */

/**
 * 各家 provider 终止原因的归一化词汇。
 *
 * 原生取值差别很大（Anthropic `stop_reason`、OpenAI Chat `finish_reason`、
 * Responses `status` + `incomplete_details.reason`、Gemini `finishReason`），
 * 循环层需要的是一个能直接判定的语义，而不是又一轮字符串考古。
 */
export type StopReason =
  /** 正常说完（含 stop_sequence）。 */
  | "end_turn"
  /** 以工具调用结束，等待执行结果。 */
  | "tool_calls"
  /** 被 max_tokens / max_output_tokens 截断——这一轮没说完。 */
  | "max_tokens"
  /** 安全策略拒答。 */
  | "refusal"
  /** Anthropic `pause_turn`：服务端工具暂停，可继续。 */
  | "paused"
  /**
   * 上游从未给出终止事件，流就结束了（适配器主动标记）。
   *
   * 与 null 的区别很关键：null 是"这个 provider 不暴露终止信息"，
   * 而这一值是"确实缺了终止状态"——回合不能判定为完成。
   */
  | "incomplete_stream"
  /** 认识但不在上述语义里的取值（含 Responses 的 `failed`）。 */
  | "unknown";

const STOP_REASON_ALIASES: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop: "end_turn",
  stop_sequence: "end_turn",
  completed: "end_turn",
  eos: "end_turn",
  tool_use: "tool_calls",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  max_tokens: "max_tokens",
  max_output_tokens: "max_tokens",
  length: "max_tokens",
  // Responses API 的 status=incomplete（reason 缺失时）同样是"没说完"。
  incomplete: "max_tokens",
  content_filter: "refusal",
  refusal: "refusal",
  safety: "refusal",
  recitation: "refusal",
  prohibited_content: "refusal",
  blocklist: "refusal",
  pause_turn: "paused",
};

/**
 * 归一化 provider 的终止原因。
 *
 * 返回 null 表示"这个 provider 没有暴露终止信息"，调用方据此**不做任何
 * 推断**——把 null 当成截断会让所有未适配的适配器全军覆没。
 */
export function normalizeStopReason(raw: string | null | undefined): StopReason | null {
  if (!raw) return null;
  const alias = STOP_REASON_ALIASES[raw.toLowerCase()];
  return alias ?? "unknown";
}
