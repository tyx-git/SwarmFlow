/**
 * 工具输入修复 — 对一小部分可恢复的错误格式工具参数的
 * 宽容强制转换，这些参数是开放模型（DeepSeek、GLM、
 * Qwen、Kimi 等）经常产生的。
 *
 * 设计原则：验证然后修复，绝不预处理。调用者首先按原样
 * 解析输入；只有在类型不匹配时才在这些修复中查找
 * 确切失败的参数。有效输入永远不会被触碰——这就是
 * 保持一个 merely *looks* like JSON 的 `write_file` `content`
 * 不会被静默重写的原因。验证器定位 bug；我们只在架构
 * 实际不同意的地方花费修复预算。
 *
 * 目录故意很小且封闭。在我们服务的开放模型中，
 * 相同的形状错误几乎完全重复：
 *   1. `null` 用于可选字段而不是省略它
 *        →已被调用者的可选参数辅助函数吸收（`v == null`）。
 *   2. `'["a","b"]'` 作为 JSON *string* 而不是数组发出。
 *   3. 一个值包装在对象 `{}` 占位符中，而需要的是数组。
 *   4. 一个裸字符串 `"foo"`，而需要的是数组 `["foo"]`。
 *
 * 顺序很重要：JSON 字符串数组解析（2）必须在
 * 裸字符串包装（4）之前运行，否则 `'["a","b"]'` 变成 `['["a","b"]']`。
 *
 * 单独地，路径特定修复解包一个模型从其聊天分发中泄漏到
 * 路径字段的退化 markdown 自动链接
 *（`"[notes.md](http://notes.md)"`），其中链接文本等于 URL 减去其
 * 协议。真正的链接（`[click](https://example.com)`）通过。
 */

export type ArgRepairKind =
  | "json_string_array"
  | "object_placeholder_unwrap"
  | "bare_string_to_array"
  | "autolink_path_unwrap";

/** 可选的遥测接收器。允许测试工具监控每个（模型、工具）的修复
 * 速率，而无需将这个纯模块耦合到 Session/日志记录。默认无操作。 */
let repairSink: ((info: { tool: string; key: string; kind: ArgRepairKind }) => void) | null = null;

export function setArgRepairSink(
  sink: ((info: { tool: string; key: string; kind: ArgRepairKind }) => void) | null,
): void {
  repairSink = sink;
}

function reportRepair(tool: string, key: string, kind: ArgRepairKind): void {
  try {
    repairSink?.({ tool, key, kind });
  } catch {
    /* telemetry must never break a tool call */
  }
}

/**
 * Attempt to coerce a non-array `value` into a string[] using repairs 2—.
 * Returns the repaired array (and which repair fired) or null if unrepairable.
 * Pure —does not report telemetry; callers report on accept so the failing
 * path is known.
 */
export function repairToStringArray(
  value: unknown,
): { value: string[]; kind: ArgRepairKind } | null {
  // (2) 字符串化的 JSON 数组 —— 必须放在下面的裸字符串包装之前。
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
          return { value: parsed as string[], kind: "json_string_array" };
        }
      } catch {
        /* 不是有效 JSON —— 继续执行裸字符串包装 */
      }
    }
    // (4) 裸字符串 → 单元素数组。
    return { value: [value], kind: "bare_string_to_array" };
  }

  // (3) 对象占位符。空对象 {} 表示空数组；
  // 所有值都是字符串的对象通过 Object.values（插入顺序）解包为那些值。
  // 注意：这仅对 element keys 没有语义的 string[] 目标安全
  //（顺序是唯一含义，例如 kill_shell/kill_agent 的 `ids`）。
  // 不要将带键语义字段通过 repairToStringArray ——
  // `{"first":..,"second":..}` 会被扁平化为无序的值列表。
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length === 0) {
      return { value: [], kind: "object_placeholder_unwrap" };
    }
    if (vals.every((x) => typeof x === "string")) {
      return { value: vals as string[], kind: "object_placeholder_unwrap" };
    }
  }

  return null;
}

/** 公共入口：修复 + 报告。返回 string[] 或 null。 */
export function coerceStringArray(
  tool: string,
  key: string,
  value: unknown,
): string[] | null {
  const repaired = repairToStringArray(value);
  if (!repaired) return null;
  reportRepair(tool, key, repaired.kind);
  return repaired.value;
}

const AUTOLINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;

/**
 * 仅解包模型泄漏到路径中的退化 markdown 自动链接：
 * 链接文本等于去掉任何 `http(s)://` 的 URL。真正的链接保持不变。
 * 返回解包后的路径（或原始字符串）。
 */
export function repairAutolinkPath(value: string): { value: string; repaired: boolean } {
  const m = value.trim().match(AUTOLINK_RE);
  if (m) {
    const text = m[1];
    const url = m[2];
    const urlNoProto = url.replace(/^https?:\/\//, "");
    if (text === url || text === urlNoProto) {
      return { value: text, repaired: true };
    }
  }
  return { value, repaired: false };
}

/** 公共入口：解包 autolink 路径 + 报告。 */
export function coercePathString(tool: string, key: string, value: string): string {
  const { value: unwrapped, repaired } = repairAutolinkPath(value);
  if (repaired) reportRepair(tool, key, "autolink_path_unwrap");
  return unwrapped;
}
