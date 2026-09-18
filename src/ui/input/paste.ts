export const LONG_PASTE_LINE_THRESHOLD = 15;

const PASTE_PREVIEW_CHARS = 20;

/**
 * 为折叠的粘贴占位符构建显示标签。
 * 格式：`[Build a CRM dashboard... Pasted Text #1 - 124 lines]`
 */
export function buildPasteLabel(text: string, index: number, lineCount: number): string {
  const flat = text.replace(/\n/g, " ").trim();
  let preview = "";
  if (flat.length > 0) {
    preview = flat.length > PASTE_PREVIEW_CHARS
      ? flat.slice(0, PASTE_PREVIEW_CHARS) + "... "
      : flat + " ";
  }
  return `[${preview}Pasted Text #${index} - ${lineCount} lines]`;
}

export interface PasteDecision {
  text: string;
  lineCount: number;
  replacedWithPlaceholder: boolean;
  index?: number;
}

export class TurnPasteCounter {
  private nextIndex = 1;

  reset(): void {
    this.nextIndex = 1;
  }

  next(): number {
    const current = this.nextIndex;
    this.nextIndex += 1;
    return current;
  }
}

export function countTextLines(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}

export function classifyPastedText(
  text: string,
  counter: TurnPasteCounter,
  threshold = LONG_PASTE_LINE_THRESHOLD,
): PasteDecision {
  const lineCount = countTextLines(text);
  if (lineCount <= threshold) {
    return {
      text,
      lineCount,
      replacedWithPlaceholder: false,
    };
  }

  const index = counter.next();
  return {
    text: buildPasteLabel(text, index, lineCount),
    lineCount,
    replacedWithPlaceholder: true,
    index,
  };
}
