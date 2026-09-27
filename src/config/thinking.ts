/**
 * 思考深度（thinking depth / effort）的唯一档位来源。
 *
 * 内置 low / medium / high / xhigh / max —— 刻意不提供 ultra：
 * 上游没有对应的 effort 值，给了只会让用户选到一个静默失效的档位。
 *
 * 各 provider 负责把档位翻译成自己的请求字段（reasoning.effort /
 * output_config.effort / thinking_budget …），但"有哪些档位"只在这里定义一次。
 */

const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 内置思考深度档位。 */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** /effort 等命令的可用档位列表（字符串数组形式）。 */
export const THINKING_LEVEL_LIST: readonly string[] = THINKING_LEVELS;

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVEL_LIST as readonly string[]).includes(value);
}

/** 档位说明：只描述真实约束，不写死某个 provider 的行为细节。 */
export const THINKING_LEVEL_NOTES: Readonly<Record<ThinkingLevel, string>> = {
  low: "",
  medium: "",
  high: "",
  xhigh: "OpenAI",
  max: "DeepSeek / Anthropic / GLM",
};
