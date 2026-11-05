/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/parser.rs
 * Modified for SwarmFlow: TypeScript port; heredoc/shell invocation omitted.
 */

/** 补丁块与 hunk 行的固定标记。 */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const EOF_MARKER = "*** End of File";
export const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

/**
 * 模型返回的补丁可能带 CRLF、孤立 CR 或重复 CR。统一成 LF 后再按行解析；
 * 重复 CR（`\r\r\n`）只算一个换行。裸块层与补丁解析共用这一份实现。
 */
export function normalizeBlockLineEndings(text: string): string {
  return text.replace(/\r+\n/g, "\n").replace(/\r/g, "\n");
}

/** 去首尾空白后按 LF 切行；空文本返回空数组。 */
export function splitPatchLines(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return normalizeBlockLineEndings(trimmed).split("\n");
}
