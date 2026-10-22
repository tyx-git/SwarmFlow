/**
 * 工具输出的截断策略。
 *
 * 单一真实来源：
 *  - truncateMiddle — 大输出的对称头+尾截断
 *  - truncateLine   — grep/read 输出的按行截断
 */

/**
 * 对称截断文本：保留 `limit` 字符的前半部分和后半部分，
 * 删除中间部分。如果文本已符合限制则返回不变。
 *
 * 由 bash 和 web_fetch 使用 —— 对于命令/页面输出，两端
 * 通常都携带信息（顶部的错误，底部的退出摘要；
 * 顶部的导航，底部的结论）。
 */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return (
    text.slice(0, half) +
    `\n\n... [truncated ${omitted.toLocaleString()} chars] ...\n\n` +
    text.slice(-half)
  );
}

/**
 * 在 `maxChars` 处截断单行。由 read_file 和 grep 使用，
 * 以防止失控的压缩行超出预算。
 */
export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return (
    line.slice(0, maxChars) +
    ` —(line truncated at ${maxChars} chars)`
  );
}
