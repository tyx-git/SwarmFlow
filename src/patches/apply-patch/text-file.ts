/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/text_file.rs
 * Modified for SwarmFlow: TypeScript port.
 */

export type LineEnding = "lf" | "crlf" | "cr";

export interface SourceLine {
  text: string;
  ending: LineEnding | null;
}

/** (startIndex, oldLength, newLines) */
export type Replacement = readonly [number, number, readonly string[]];

function endingText(ending: LineEnding): string {
  switch (ending) {
    case "crlf":
      return "\r\n";
    case "cr":
      return "\r";
    default:
      return "\n";
  }
}

/**
 * 按逻辑行保存原文，并逐行保留各自的 EOL；插入行使用文件首个 EOL。
 * 更新后所有缺 EOL 的行都会补上 preferred EOL（codex 的历史行为）。
 */
export class SourceFile {
  private lines: SourceLine[];
  private readonly preferredEnding: LineEnding;

  private constructor(lines: SourceLine[], preferredEnding: LineEnding) {
    this.lines = lines;
    this.preferredEnding = preferredEnding;
  }

  static parse(contents: string): SourceFile {
    const lines: SourceLine[] = [];
    let preferredEnding: LineEnding | null = null;
    let lineStart = 0;
    let cursor = 0;

    while (cursor < contents.length) {
      const code = contents.charCodeAt(cursor);
      let ending: LineEnding | null = null;
      let endingLength = 0;
      if (code === 13 && contents.charCodeAt(cursor + 1) === 10) {
        ending = "crlf";
        endingLength = 2;
      } else if (code === 13) {
        ending = "cr";
        endingLength = 1;
      } else if (code === 10) {
        ending = "lf";
        endingLength = 1;
      }
      if (!ending) {
        cursor += 1;
        continue;
      }
      preferredEnding ??= ending;
      lines.push({ text: contents.slice(lineStart, cursor), ending });
      cursor += endingLength;
      lineStart = cursor;
    }

    if (lineStart < contents.length) {
      lines.push({ text: contents.slice(lineStart), ending: null });
    }

    return new SourceFile(lines, preferredEnding ?? "lf");
  }

  lineTexts(): string[] {
    return this.lines.map((line) => line.text);
  }

  applyReplacements(replacements: readonly Replacement[]): void {
    const source = this.lines.slice();
    const next: SourceLine[] = [];
    let sourceIndex = 0;

    for (const [startIndex, oldLength, newSegment] of replacements) {
      if (startIndex < sourceIndex) {
        throw new Error(
          `overlapping replacements: start ${startIndex} is before ${sourceIndex}`,
        );
      }
      for (const line of source.slice(sourceIndex, startIndex)) {
        next.push(line);
      }
      for (const text of newSegment) {
        next.push({ text, ending: this.preferredEnding });
      }
      sourceIndex = startIndex + oldLength;
    }

    for (const line of source.slice(sourceIndex)) {
      next.push(line);
    }

    for (const line of next) {
      line.ending ??= this.preferredEnding;
    }
    this.lines = next;
  }

  intoContents(): string {
    let contents = "";
    for (const line of this.lines) {
      contents += line.text;
      if (line.ending) contents += endingText(line.ending);
    }
    return contents;
  }
}
