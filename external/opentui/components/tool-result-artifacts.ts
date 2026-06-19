import { extname } from "node:path";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { highlightToChunks } from "../forked/patch-opentui-markdown.js";

import type { ConversationEntry } from "../../../src/ui/contracts.js";
import type { ConversationPalette } from "./conversation-types.js";
import {
  LANGUAGE_BY_EXTENSION,
  DIFF_BRIGHTNESS_ADDITION,
  DIFF_BRIGHTNESS_DELETION,
  DIFF_BRIGHTNESS_CONTEXT,
  createChunk,
  adjustBrightness,
  cloneChunksWithBaseStyle,
  wrapStandaloneChunks,
  buildWrappedArtifacts,
  type ToolResultLineArtifact,
} from "./syntax-highlight-utils.js";

// Re-export for consumers that import from this module
export type { ToolResultLineArtifact } from "./syntax-highlight-utils.js";

// ------------------------------------------------------------------
// Local helpers
// ------------------------------------------------------------------

type ToolMetadata = Record<string, unknown>;

interface ToolResultArtifactOptions {
  text: string;
  dim?: boolean;
  toolMetadata?: ToolMetadata;
  wrapWidth?: number;
  colors: ConversationPalette;
  /** When true, extract only the new file content from diff text and render as syntax-highlighted code. */
  codePreviewOnly?: boolean;
}

function parseDiffPreviewKind(toolMetadata?: ToolMetadata): string | null {
  const preview = toolMetadata?.["tui_preview"];
  if (!preview || typeof preview !== "object") return null;
  const kind = (preview as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : null;
}

function inferDiffLanguage(toolMetadata?: ToolMetadata): string | undefined {
  const pathValue = typeof toolMetadata?.["path"] === "string"
    ? toolMetadata["path"] as string
    : null;
  if (pathValue) {
    return LANGUAGE_BY_EXTENSION[extname(pathValue).toLowerCase()];
  }

  const paths = Array.isArray(toolMetadata?.["paths"]) ? toolMetadata["paths"] as unknown[] : null;
  if (paths && paths.length === 1 && typeof paths[0] === "string") {
    return LANGUAGE_BY_EXTENSION[extname(paths[0]).toLowerCase()];
  }

  return undefined;
}

function parsePreviewLine(line: string): { prefix: string; raw: string } {
  const numberedLineMatch = line.match(/^(\s*\d+\s)([+\- ].*)$/);
  if (numberedLineMatch) {
    return {
      prefix: numberedLineMatch[1],
      raw: numberedLineMatch[2],
    };
  }

  const blankPrefixMatch = line.match(/^(\s+)(@@.*|--- .*|\+\+\+ .*|\.\.\..*)$/);
  if (blankPrefixMatch) {
    return {
      prefix: blankPrefixMatch[1],
      raw: blankPrefixMatch[2],
    };
  }

  return { prefix: "", raw: line };
}

function isLikelyDiffPreview(text: string): boolean {
  return /(?:^|\n)\s*\d+\s[+\- ]/.test(text)
    || /(?:^|\n)\s+@@ /.test(text)
    || /(?:^|\n)\s+--- /.test(text)
    || /(?:^|\n)\s+\+\+\s/.test(text);
}

// ------------------------------------------------------------------
// Artifact builders
// ------------------------------------------------------------------

function buildPlainToolResultArtifacts(
  { text, dim, colors, wrapWidth }: Pick<ToolResultArtifactOptions, "text" | "dim" | "colors" | "wrapWidth">,
): ToolResultLineArtifact[] {
  // Result body uses two-tier dim palette (darker than tool call args).
  const fg = RGBA.fromHex(dim ? colors.dim : "#5a6078");
  return text.split("\n").flatMap((line) =>
    wrapStandaloneChunks([createChunk(line || " ", { fg })], wrapWidth),
  );
}

function buildDiffLineArtifact(
  line: string,
  colors: ConversationPalette,
  language: string | undefined,
  wrapWidth?: number,
): ToolResultLineArtifact[] {
  const { prefix, raw } = parsePreviewLine(line);

  const dimFg = RGBA.fromHex(colors.dim);
  const textFg = RGBA.fromHex(colors.text);
  const greenFg = RGBA.fromHex(colors.green);
  const redFg = RGBA.fromHex(colors.red);
  const additionBg = "#285438";
  const deletionBg = "#6a3232";

  if (raw.startsWith("@@")) {
    return [];
  }

  if (raw.startsWith("...")) {
    const chunks: TextChunk[] = [];
    if (prefix) {
      chunks.push(createChunk(prefix, { fg: dimFg }));
    }
    chunks.push(createChunk(raw, { fg: dimFg }));
    return wrapStandaloneChunks(chunks, wrapWidth);
  }

  if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
    return [];
  }

  const marker = raw[0] ?? "";
  const payload = raw.length > 0 ? raw.slice(1) : raw;
  const blankPrefix = " ".repeat(prefix.length);

  if (marker === "+" || marker === "-") {
    const isAddition = marker === "+";
    const markerFg = isAddition ? greenFg : redFg;
    const rowBackgroundColor = isAddition ? additionBg : deletionBg;
    const brightness = isAddition ? DIFF_BRIGHTNESS_ADDITION : DIFF_BRIGHTNESS_DELETION;
    const prefixChunks: TextChunk[] = [];
    if (prefix) {
      prefixChunks.push(createChunk(prefix, { fg: markerFg }));
    }
    prefixChunks.push(createChunk(marker, { fg: markerFg }));

    let payloadChunks: TextChunk[];
    const highlightedPayload = language ? highlightToChunks(payload, language) : null;
    if (highlightedPayload && highlightedPayload.length > 0) {
      payloadChunks = cloneChunksWithBaseStyle(highlightedPayload, { fallbackFg: markerFg, brightness });
    } else {
      payloadChunks = [createChunk(payload || " ", { fg: adjustBrightness(markerFg, brightness)! })];
    }
    return buildWrappedArtifacts({
      prefixChunks,
      continuationPrefixChunks: [createChunk(`${blankPrefix}${marker}`, { fg: markerFg })],
      payloadChunks,
      rowBackgroundColor,
      wrapWidth,
    });
  }

  const chunks: TextChunk[] = [];
  if (prefix) {
    chunks.push(createChunk(prefix, { fg: dimFg }));
  }
  if (marker === " ") {
    const prefixChunks = [...chunks, createChunk(marker, { fg: dimFg })];
    let payloadChunks: TextChunk[];
    const highlightedPayload = language ? highlightToChunks(payload, language) : null;
    if (highlightedPayload && highlightedPayload.length > 0) {
      payloadChunks = cloneChunksWithBaseStyle(highlightedPayload, { fallbackFg: textFg, brightness: DIFF_BRIGHTNESS_CONTEXT });
    } else {
      payloadChunks = [createChunk(payload || " ", { fg: adjustBrightness(textFg, DIFF_BRIGHTNESS_CONTEXT)! })];
    }
    return buildWrappedArtifacts({
      prefixChunks,
      continuationPrefixChunks: [createChunk(`${blankPrefix}${marker}`, { fg: dimFg })],
      payloadChunks,
      wrapWidth,
    });
  }

  chunks.push(createChunk(raw || " ", { fg: textFg }));
  return wrapStandaloneChunks(chunks, wrapWidth);
}

/**
 * Extract new file content from diff text: keep addition (+) and context ( )
 * lines, skip deletions (-), headers, hunks, and fold markers.
 */
function extractNewContentLines(text: string): string[] {
  const codeLines: string[] = [];
  for (const line of text.split("\n")) {
    const { raw } = parsePreviewLine(line);
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("...")) continue;
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+")) { codeLines.push(raw.slice(1)); continue; }
    if (raw.startsWith(" ")) { codeLines.push(raw.slice(1)); continue; }
  }
  return codeLines;
}

function buildCodePreviewArtifacts(
  { text, colors, toolMetadata, wrapWidth }: Pick<ToolResultArtifactOptions, "text" | "colors" | "toolMetadata" | "wrapWidth">,
): ToolResultLineArtifact[] {
  const language = inferDiffLanguage(toolMetadata);
  const textFg = RGBA.fromHex(colors.text);

  // Prefer full new content from backend; fall back to extracting from diff text
  const preview = toolMetadata?.["tui_preview"];
  const newContent = preview && typeof preview === "object"
    ? (preview as Record<string, unknown>)["newContent"]
    : undefined;
  const codeLines = typeof newContent === "string"
    ? newContent.split("\n")
    : extractNewContentLines(text);

  if (codeLines.length === 0) {
    return buildPlainToolResultArtifacts({ text, colors, wrapWidth });
  }

  return codeLines.flatMap((codeLine) => {
    const highlighted = language ? highlightToChunks(codeLine, language) : null;
    if (highlighted && highlighted.length > 0) {
      return wrapStandaloneChunks(
        cloneChunksWithBaseStyle(highlighted, { fallbackFg: textFg }),
        wrapWidth,
      );
    }
    return wrapStandaloneChunks(
      [createChunk(codeLine || " ", { fg: textFg })],
      wrapWidth,
    );
  });
}

function buildDiffToolResultArtifacts(
  { text, colors, toolMetadata, wrapWidth }: Pick<ToolResultArtifactOptions, "text" | "colors" | "toolMetadata" | "wrapWidth">,
): ToolResultLineArtifact[] {
  const lines = text.split("\n");
  const language = inferDiffLanguage(toolMetadata);

  return lines
    .flatMap((line) => buildDiffLineArtifact(line, colors, language, wrapWidth));
}

export function buildToolResultArtifacts(
  options: ToolResultArtifactOptions,
): ToolResultLineArtifact[] {
  if (options.dim) {
    return buildPlainToolResultArtifacts(options);
  }

  if (options.codePreviewOnly) {
    return buildCodePreviewArtifacts(options);
  }

  const previewKind = parseDiffPreviewKind(options.toolMetadata);
  if (previewKind === "diff" || isLikelyDiffPreview(options.text)) {
    return buildDiffToolResultArtifacts(options);
  }

  return buildPlainToolResultArtifacts(options);
}

export function getToolResultMetadata(
  entry: ConversationEntry,
): ToolMetadata | undefined {
  const metadata = entry.meta?.toolMetadata;
  return metadata && typeof metadata === "object"
    ? metadata as ToolMetadata
    : undefined;
}

export function inferToolResultLanguage(
  entry: ConversationEntry,
): string | undefined {
  return inferDiffLanguage(getToolResultMetadata(entry));
}
