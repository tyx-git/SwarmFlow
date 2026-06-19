/**
 * 简易 JSONC（带注释的 JSON）解析器。
 *
 * 然后交给 `JSON.parse` 处理。
 *
 * 不会移除 JSON 字符串值内部的注释——正则将引号字符串
 * 视为不透明标记，因此 `"http://example.com"` 会完整保留。
 */

/**
 * 从 JSONC 字符串中移除注释并返回纯 JSON。
 */
export function stripJsoncComments(text: string): string {
  // Match (in order):
  //   1. double-quoted strings (preserve as-is)
  //   2. single-line comments  (// ... EOL)
  //   3. multi-line comments   (/* ... */)
  return text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => {
      if (match.startsWith('"')) return match; // preserve string literals
      // Replace comment with equivalent whitespace to keep line numbers stable
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
