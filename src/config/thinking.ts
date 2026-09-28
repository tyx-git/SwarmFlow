/**
 * 思考深度（thinking depth / effort）的默认档位来源。
 *
 * 默认选项由 settings.json 覆盖；用户可以在那里保留任意供应商支持的档位。
 * 这里仅提供首次启动时的默认列表，不用于判断模型能力。
 */

const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

/** settings.json 未配置 thinking_levels 时的默认选项。 */
export const THINKING_LEVEL_LIST: readonly string[] = THINKING_LEVELS;
