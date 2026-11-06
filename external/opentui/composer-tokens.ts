import { SyntaxStyle, parseColor, type TextareaRenderable, type ColorInput } from "@opentui/core";
import {
  buildFileReferenceLabel,
  displayWidthWithNewlines,
  findFileReferenceQuery,
  getDisplaySpanEndingAtOffset,
  getDisplaySpanStartingAtOffset,
  getSlashCommandTokenRange,
  getTextDiffRange,
  serializeVisibleTextWithTokens,
  sliceTextByOffset,
  type ComposerTokenMetadata,
  type ComposerTokenSnapshot,
  type FileReferenceQuery,
  type TextDiffRange,
} from "./composer-token-logic.js";

export interface ComposerTokenVisuals {
  syntaxStyle: SyntaxStyle;
  fileStyleId: number;
  pasteStyleId: number;
  imageStyleId: number;
  slashStyleId: number;
}

const COMPOSER_TOKEN_TYPE = "composer-token";
const SLASH_COMMAND_TYPE = "slash-command";
const COMPOSER_EXTMARK_PATCHED = Symbol("swarmflow.composer-extmarks-patched");

export function createComposerTokenVisuals(colors: {
  accent: ColorInput;
  cyan: ColorInput;
  yellow: ColorInput;
  slashCommand: ColorInput;
}): ComposerTokenVisuals {
  const syntaxStyle = SyntaxStyle.create();
  const fileStyleId = syntaxStyle.registerStyle("composer.token.file", {
    fg: parseColor(colors.cyan),
    bold: true,
  });
  const pasteStyleId = syntaxStyle.registerStyle("composer.token.paste", {
    fg: parseColor(colors.yellow),
    bold: true,
  });
  const imageStyleId = syntaxStyle.registerStyle("composer.token.image", {
    fg: parseColor(colors.accent),
    bold: true,
  });
  const slashStyleId = syntaxStyle.registerStyle("composer.token.slash", {
    fg: parseColor(colors.slashCommand),
    bold: true,
  });
  return {
    syntaxStyle,
    fileStyleId,
    pasteStyleId,
    imageStyleId,
    slashStyleId,
  };
}

export function ensureComposerTokenType(composer: TextareaRenderable): number {
  const existing = composer.extmarks.getTypeId(COMPOSER_TOKEN_TYPE);
  if (existing !== null) return existing;
  return composer.extmarks.registerType(COMPOSER_TOKEN_TYPE);
}

export function ensureSlashCommandType(composer: TextareaRenderable): number {
  const existing = composer.extmarks.getTypeId(SLASH_COMMAND_TYPE);
  if (existing !== null) return existing;
  return composer.extmarks.registerType(SLASH_COMMAND_TYPE);
}

/**
 * 重算行首命令令牌的高亮区间。
 *
 * 每次按键先比对现有 extmark，区间没变就整段跳过（不做无谓的原生重挂）；变了
 * 才先删后建。用独立 typeId 与 `virtual: false`：虚拟标记会让退格把整段当成原子
 * token 一次删掉，而序列化提交文本时也不能把命令标记当成 composer token。
 *
 * 建/删之后必须重新赋值 `syntaxStyle` 才会重绘：@opentui/core 0.4.1 只在
 * setter 里把高亮同步进原生缓冲，`extmarks.create()` 自身不触发重绘，否则着色
 * 会慢一拍（下一个字符才染上、删掉开头的 `/` 后旧紫色还赖在屏上）。
 */
export function refreshSlashCommandHighlight(
  composer: TextareaRenderable | null | undefined,
  visuals: ComposerTokenVisuals,
  isRegistered: (token: string) => boolean,
): void {
  if (!composer || composer.isDestroyed) return;

  const typeId = ensureSlashCommandType(composer);
  const marks = composer.extmarks.getAllForTypeId(typeId);
  const range = getSlashCommandTokenRange(composer.plainText, isRegistered);
  const only = marks.length === 1 ? marks[0] : undefined;
  const unchanged =
    (range === null && marks.length === 0) ||
    (range !== null &&
      only !== undefined &&
      only.start === range.start &&
      only.end === range.end &&
      only.styleId === visuals.slashStyleId);
  if (unchanged) return;

  for (const mark of marks) composer.extmarks.delete(mark.id);
  if (!range) {
    composer.syntaxStyle = visuals.syntaxStyle;
    return;
  }

  composer.extmarks.create({
    start: range.start,
    end: range.end,
    virtual: false,
    styleId: visuals.slashStyleId,
    typeId,
  });
  composer.syntaxStyle = visuals.syntaxStyle;
}

export function patchComposerExtmarksForDisplayWidth(composer: TextareaRenderable): void {
  const extmarks = composer.extmarks as any;
  if (extmarks[COMPOSER_EXTMARK_PATCHED]) return;
  extmarks[COMPOSER_EXTMARK_PATCHED] = true;

  const editBuffer = composer.editBuffer as any;
  const editorView = composer.editorView as any;

  editBuffer.insertText = (text: string): void => {
    if (extmarks.destroyed) {
      extmarks.originalInsertText(text);
      return;
    }

    extmarks.saveSnapshot();
    const currentOffset = editorView.getVisualCursor().offset;
    extmarks.originalInsertText(text);
    extmarks.adjustExtmarksAfterInsertion(currentOffset, displayWidthWithNewlines(text));
  };

  editBuffer.insertChar = (char: string): void => {
    if (extmarks.destroyed) {
      extmarks.originalInsertChar(char);
      return;
    }

    extmarks.saveSnapshot();
    const currentOffset = editorView.getVisualCursor().offset;
    extmarks.originalInsertChar(char);
    extmarks.adjustExtmarksAfterInsertion(currentOffset, displayWidthWithNewlines(char));
  };

  editBuffer.deleteCharBackward = (): void => {
    if (extmarks.destroyed) {
      extmarks.originalDeleteCharBackward();
      return;
    }

    extmarks.saveSnapshot();

    const currentOffset = editorView.getVisualCursor().offset;
    const hadSelection = editorView.hasSelection();
    if (currentOffset === 0) {
      extmarks.originalDeleteCharBackward();
      return;
    }
    if (hadSelection) {
      extmarks.originalDeleteCharBackward();
      return;
    }

    const span = getDisplaySpanEndingAtOffset(composer.plainText, currentOffset);
    const targetOffset = span?.startOffset ?? Math.max(0, currentOffset - 1);
    const deleteLength = span ? span.endOffset - span.startOffset : 1;
    const virtualExtmark = extmarks.findVirtualExtmarkContaining(targetOffset);

    if (virtualExtmark && currentOffset === virtualExtmark.end) {
      const startCursor = extmarks.offsetToPosition(virtualExtmark.start);
      const endCursor = extmarks.offsetToPosition(virtualExtmark.end);

      extmarks.deleteExtmarkById(virtualExtmark.id);
      extmarks.originalDeleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col);
      extmarks.adjustExtmarksAfterDeletion(virtualExtmark.start, virtualExtmark.end - virtualExtmark.start);
      extmarks.updateHighlights();
      return;
    }

    extmarks.originalDeleteCharBackward();
    extmarks.adjustExtmarksAfterDeletion(targetOffset, deleteLength);
  };

  editBuffer.deleteChar = (): void => {
    if (extmarks.destroyed) {
      extmarks.originalDeleteChar();
      return;
    }

    extmarks.saveSnapshot();

    const currentOffset = editorView.getVisualCursor().offset;
    const hadSelection = editorView.hasSelection();
    if (hadSelection) {
      extmarks.originalDeleteChar();
      return;
    }

    const span = getDisplaySpanStartingAtOffset(composer.plainText, currentOffset);
    const deleteLength = span ? span.endOffset - span.startOffset : 1;
    const targetOffset = span?.startOffset ?? currentOffset;
    const virtualExtmark = extmarks.findVirtualExtmarkContaining(targetOffset);

    if (virtualExtmark && currentOffset === virtualExtmark.start) {
      const startCursor = extmarks.offsetToPosition(virtualExtmark.start);
      const endCursor = extmarks.offsetToPosition(virtualExtmark.end);

      extmarks.deleteExtmarkById(virtualExtmark.id);
      extmarks.originalDeleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col);
      extmarks.adjustExtmarksAfterDeletion(virtualExtmark.start, virtualExtmark.end - virtualExtmark.start);
      extmarks.updateHighlights();
      return;
    }

    extmarks.originalDeleteChar();
    extmarks.adjustExtmarksAfterDeletion(targetOffset, deleteLength);
  };
}

export function getComposerTokenSnapshots(
  composer: TextareaRenderable,
  typeId = ensureComposerTokenType(composer),
): ComposerTokenSnapshot[] {
  return composer.extmarks
    .getAllForTypeId(typeId)
    .map((extmark: { id: number; start: number; end: number }) => {
      const metadata = composer.extmarks.getMetadataFor(extmark.id) as ComposerTokenMetadata | undefined;
      if (!metadata) return null;
      return {
        id: extmark.id,
        start: extmark.start,
        end: extmark.end,
        ...metadata,
      };
    })
    .filter((token: ComposerTokenSnapshot | null): token is ComposerTokenSnapshot => token !== null)
    .sort((a, b) => a.start - b.start);
}

export function serializeComposerText(
  composer: TextareaRenderable,
  typeId = ensureComposerTokenType(composer),
): string {
  const tokens = getComposerTokenSnapshots(composer, typeId);
  return serializeVisibleTextWithTokens(composer.plainText, tokens);
}

export function replaceRangeWithComposerToken(
  composer: TextareaRenderable,
  {
    rangeStart,
    rangeEnd,
    label,
    metadata,
    styleId,
    trailingText = "",
  }: {
    rangeStart: number;
    rangeEnd: number;
    label: string;
    metadata: ComposerTokenMetadata;
    styleId: number;
    trailingText?: string;
  },
): void {
  const typeId = ensureComposerTokenType(composer);
  if (rangeEnd > rangeStart) {
    const startPos = composer.editBuffer.offsetToPosition(rangeStart);
    const endPos = composer.editBuffer.offsetToPosition(rangeEnd);
    if (startPos && endPos) {
      composer.editBuffer.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col);
    }
  }

  composer.cursorOffset = rangeStart;
  composer.editBuffer.insertText(label);

  const labelWidth = displayWidthWithNewlines(label);
  composer.extmarks.create({
    start: rangeStart,
    end: rangeStart + labelWidth,
    virtual: true,
    styleId,
    typeId,
    metadata,
  });

  composer.cursorOffset = rangeStart + labelWidth;
  if (trailingText) {
    composer.editBuffer.insertText(trailingText);
  }
}
export {
  buildFileReferenceLabel,
  displayWidthWithNewlines,
  findFileReferenceQuery,
  getSlashCommandTokenRange,
  getTextDiffRange,
  sliceTextByOffset,
};
export type { ComposerTokenMetadata, ComposerTokenSnapshot, FileReferenceQuery, TextDiffRange };
