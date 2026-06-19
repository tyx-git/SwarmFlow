import { SyntaxStyle, parseColor, type TextareaRenderable, type ColorInput } from "@opentui/core";
import {
  buildFileReferenceLabel,
  displayWidthWithNewlines,
  findFileReferenceQuery,
  getDisplaySpanEndingAtOffset,
  getDisplaySpanStartingAtOffset,
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
}

const COMPOSER_TOKEN_TYPE = "composer-token";
const COMPOSER_EXTMARK_PATCHED = Symbol("fermi.composer-extmarks-patched");

export function createComposerTokenVisuals(colors: {
  accent: ColorInput;
  cyan: ColorInput;
  yellow: ColorInput;
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
  return {
    syntaxStyle,
    fileStyleId,
    pasteStyleId,
    imageStyleId,
  };
}

export function ensureComposerTokenType(composer: TextareaRenderable): number {
  const existing = composer.extmarks.getTypeId(COMPOSER_TOKEN_TYPE);
  if (existing !== null) return existing;
  return composer.extmarks.registerType(COMPOSER_TOKEN_TYPE);
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
  getTextDiffRange,
  sliceTextByOffset,
};
export type { ComposerTokenMetadata, ComposerTokenSnapshot, FileReferenceQuery, TextDiffRange };
