/**
 * 从 assistant 正文中抽取 apply_patch 补丁块。
 *
 * 工具调用本身零参数，补丁正文是同一轮消息里的裸文本；这里只负责切块，
 * 不做语法校验（校验由 parser 完成）。容忍前后散文、可选代码围栏与 CRLF。
 */

import { BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./markers.js";

export interface PatchBlock {
  /** 0-based，包含 Begin 行 */
  startLine: number;
  /** 0-based，包含 End 行；未闭合时等于最后一行 */
  endLine: number;
  text: string;
  complete: boolean;
}

export function findPatchBlocks(text: string): PatchBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: PatchBlock[] = [];

  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.trim() !== BEGIN_PATCH_MARKER) continue;
    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (lines[cursor]!.trim() === END_PATCH_MARKER) {
        end = cursor;
        break;
      }
    }
    if (end === -1) {
      blocks.push({
        startLine: index,
        endLine: lines.length - 1,
        text: lines.slice(index).join("\n"),
        complete: false,
      });
      break;
    }
    blocks.push({
      startLine: index,
      endLine: end,
      text: lines.slice(index, end + 1).join("\n"),
      complete: true,
    });
    index = end;
  }

  return blocks;
}

export function extractCompletePatchBlocks(text: string): string[] {
  return findPatchBlocks(text)
    .filter((block) => block.complete)
    .map((block) => block.text);
}

/**
 * 只改展示文本：移除给定的行区间。调用方负责决定哪些块该隐藏
 * （例如仅在同一轮存在 edit 调用时）。
 */
export function removePatchBlocks(
  text: string,
  blocks: readonly PatchBlock[],
): string {
  if (blocks.length === 0) return text;
  const lines = text.split(/\r?\n/);
  const hidden = new Set<number>();
  const isFence = (line: string | undefined): boolean => {
    const trimmed = line?.trim() ?? "";
    return trimmed.startsWith("```") || trimmed.startsWith("~~~");
  };
  for (const block of blocks) {
    for (let index = block.startLine; index <= block.endLine; index++) {
      hidden.add(index);
    }
    // 模型常把补丁包在代码围栏里；围栏本身也属于补丁展示，不要留下空壳。
    if (block.startLine > 0 && isFence(lines[block.startLine - 1])) {
      hidden.add(block.startLine - 1);
    }
    if (block.endLine + 1 < lines.length && isFence(lines[block.endLine + 1])) {
      hidden.add(block.endLine + 1);
    }
  }
  return lines.filter((_, index) => !hidden.has(index)).join("\n");
}
