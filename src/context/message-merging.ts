/** 合并连续同角色消息，满足严格角色交替的 provider 要求。 */

export function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];

  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg["role"] as string;

    // 永不合并这些——但处理相邻 assistant 的边缘情况
    if (
      role === "system" ||
      role === "tool_result"
    ) {
      result.push(msg);
      continue;
    }

    if (role === "assistant" && msg["tool_calls"]) {
      // 如果前一条消息是纯文本 assistant（例如历史摘要插入的内容），
      // 将其文本合并到此消息中，以避免违反严格角色交替要求的连续模型 turn。
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (
        prev &&
        prev["role"] === "assistant" &&
        !prev["tool_calls"]
      ) {
        const prevText =
          (typeof prev["content"] === "string" ? prev["content"] : "") ||
          (typeof prev["text"] === "string" ? prev["text"] : "");
        if (prevText) {
          const merged = { ...msg };
          const curText =
            (typeof merged["text"] === "string" ? merged["text"] : "") ||
            (typeof merged["content"] === "string" ? merged["content"] : "");
          merged["text"] = curText ? `${prevText}\n\n${curText}` : prevText;
          result.pop();
          result.push(merged);
        } else {
          // 前一条为空——直接移除
          result.pop();
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (!prev || prev["role"] !== role) {
      result.push(msg);
      continue;
    }

    // 前一条消息也不应是"永不合并"类型
    if (
      prev["role"] === "system" ||
      prev["role"] === "tool_result" ||
      (prev["role"] === "assistant" && prev["tool_calls"])
    ) {
      result.push(msg);
      continue;
    }

    // 合并到前一条消息
    const prevContent = prev["content"];
    const curContent = msg["content"];

    prev["content"] = mergeContent(prevContent, curContent);
  }

  return result;
}

/**
 * 合并两个消息内容值。
 * 处理 string + string、array + array、string + array、array + string。
 */
function mergeContent(
  a: unknown,
  b: unknown,
): string | Array<Record<string, unknown>> {
  const aIsString = typeof a === "string";
  const bIsString = typeof b === "string";
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);

  if (aIsString && bIsString) {
    return `${a}\n\n${b}`;
  }

  // 将字符串转换为文本块用于数组合并
  const aBlocks = aIsArray
    ? (a as Array<Record<string, unknown>>)
    : aIsString
      ? [{ type: "text", text: a }]
      : [{ type: "text", text: String(a) }];

  const bBlocks = bIsArray
    ? (b as Array<Record<string, unknown>>)
    : bIsString
      ? [{ type: "text", text: b }]
      : [{ type: "text", text: String(b) }];

  return [...aBlocks, ...bBlocks];
}
