/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/file_update.rs
 * Modified for SwarmFlow: TypeScript port.
 */

import type { UpdateFileChunk } from "./parser.js";
import { seekSequence } from "./seek-sequence.js";
import { SourceFile, type Replacement } from "./text-file.js";

export class ComputeReplacementsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeReplacementsError";
  }
}

export interface AppliedFileUpdate {
  originalContents: string;
  newContents: string;
}

export function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const index = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (index === null) {
        throw new ComputeReplacementsError(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = index + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, chunk.newLines.slice()]);
      continue;
    }

    let pattern: readonly string[] = chunk.oldLines;
    let newSlice: readonly string[] = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new ComputeReplacementsError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    // Context lines appear on both sides of the chunk. Keep the original
    // lines in place so their exact contents and terminators survive.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) {
        break;
      }
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          found + oldStart,
          oldContext - oldStart,
          newSlice.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([
        found + oldStart,
        pattern.length - oldStart,
        newSlice.slice(newStart),
      ]);
    }
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

export function deriveNewContentsFromChunks(
  originalContents: string,
  path: string,
  chunks: readonly UpdateFileChunk[],
): AppliedFileUpdate {
  const source = SourceFile.parse(originalContents);
  const replacements = computeReplacements(source.lineTexts(), path, chunks);
  source.applyReplacements(replacements);
  return {
    originalContents,
    newContents: source.intoContents(),
  };
}
