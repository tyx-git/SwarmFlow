/**
 * 简易 JSONC（带注释的 JSON）解析器。
 *
 * `stripJsoncComments` 先把注释替换成空格，再交给 `JSON.parse`。
 * 不会移除 JSON 字符串值内部的注释——正则把引号字符串视为不透明
 * 标记，因此 `"http://example.com"` 会完整保留。
 */

/**
 * 从 JSONC 字符串中移除注释并返回纯 JSON。
 */
export function stripJsoncComments(text: string): string {
  // 按顺序匹配：
  //   1. 双引号字符串（原样保留）
  //   2. 单行注释  (// ... 到行尾)
  //   3. 多行注释   (/* ... */)
  return text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => {
      if (match.startsWith('"')) return match; // 保留字符串字面量
      // 用等效的空格替换注释以保持行号稳定
      return match.replace(/[^\n]/g, " ");
    },
  );
}

/**
 * 解析 JSONC 字符串。失败时返回 `undefined` 而不是抛出异常。
 */
export function parseJsonc<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(stripJsoncComments(text)) as T;
  } catch {
    return undefined;
  }
}
