/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/{parser,streaming_parser}.rs
 * Modified for SwarmFlow: TypeScript port; heredoc/shell invocation omitted.
 */

import {
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  ENVIRONMENT_ID_MARKER,
  EOF_MARKER,
  splitPatchLines,
} from "./markers.js";

export interface UpdateFileChunk {
  /** `@@ xxx` 的锚点；只用于定位，不参与替换。 */
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  /** (oldLines 下标, newLines 下标) 对，标识真正的 context 行。 */
  contextLineIndices: Array<[number, number]>;
  isEndOfFile: boolean;
}

export type Hunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      movePath: string | null;
      chunks: UpdateFileChunk[];
    };

export type ParseErrorKind = "invalid_patch" | "invalid_hunk";

export class ParseError extends Error {
  readonly kind: ParseErrorKind;
  readonly lineNumber?: number;

  constructor(kind: ParseErrorKind, message: string, lineNumber?: number) {
    super(message);
    this.name = "ParseError";
    this.kind = kind;
    if (lineNumber !== undefined) this.lineNumber = lineNumber;
  }
}

export function formatParseError(error: ParseError): string {
  if (error.kind === "invalid_patch") {
    return `Invalid patch: ${error.message}`;
  }
  return `Invalid patch hunk on line ${error.lineNumber ?? 0}: ${error.message}`;
}

interface HunkHeader {
  kind: "add" | "delete" | "update";
  path: string;
}

const HUNK_HEADER_RE = /^\*\*\* (Add|Delete|Update) File:[ \t]+(.+)$/;
const MOVE_TO_RE = /^\*\*\* Move to:[ \t]+(.+)$/;
const ANCHOR_RE = /^@@(?:[ \t]+(.*))?$/;

/** 模型可能把标记后的空格写成多个空格或 tab；路径取首个非空白后的内容。 */
function matchHunkHeader(trimmed: string): HunkHeader | null {
  const match = HUNK_HEADER_RE.exec(trimmed);
  if (!match) return null;
  return {
    kind: match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : "update",
    path: match[2]!,
  };
}

function isAnchorLine(line: string): boolean {
  return ANCHOR_RE.test(line);
}

function isFormattingBlank(line: string): boolean {
  // 单个空格是“空 context 行”的显式写法；其余纯空白按格式空行处理。
  return line.trim() === "" && line !== " ";
}

function nextNonBlank(lines: readonly string[], from: number): string | undefined {
  for (let index = from; index < lines.length; index++) {
    if (!isFormattingBlank(lines[index]!)) return lines[index];
  }
  return undefined;
}

/**
 * 模型常在 hunk 之间、`@@` 前后或 `*** End Patch` 前插入空行。
 * 这些位置的空行不可能是有效内容；删掉它们。Update chunk 内部
 * 两条内容行之间的空行仍保留为 empty context。
 */
function stripSeparatorBlankLines(lines: readonly string[]): string[] {
  type BlockMode = "started" | "add" | "delete" | "update" | "ended";
  const result: string[] = [];
  let mode: BlockMode = "started";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (isFormattingBlank(line)) {
      const previous = result.length > 0 ? result[result.length - 1] : undefined;
      const next = nextNonBlank(lines, index + 1);
      const headerOf = (value: string | undefined): boolean => (
        value !== undefined
        && matchHunkHeader(mode === "update" ? value : value.trim()) !== null
      );
      const nextIsMarker = next !== undefined && (
        headerOf(next)
        || (mode === "update" && isAnchorLine(next))
        || next.trim() === END_PATCH_MARKER
        || next.trim() === EOF_MARKER
      );
      const previousIsChunkStart = previous === undefined
        || headerOf(previous)
        || (mode === "update" && isAnchorLine(previous));
      if (mode !== "update" || nextIsMarker || previousIsChunkStart) {
        continue;
      }
    }

    result.push(line);
    if (line.trim() === END_PATCH_MARKER) {
      mode = "ended";
      continue;
    }
    const header = matchHunkHeader(mode === "update" ? line : line.trim());
    if (header) {
      mode = header.kind;
    }
  }

  return result;
}

function invalidPatch(message: string): ParseError {
  return new ParseError("invalid_patch", message);
}

function invalidHunk(message: string, lineNumber: number): ParseError {
  return new ParseError("invalid_hunk", message, lineNumber);
}

type Mode =
  | { type: "not_started" }
  | { type: "started_patch" }
  | { type: "add_file"; hunkIndex: number }
  | { type: "delete_file"; hunkIndex: number }
  | { type: "update_file"; hunkIndex: number; hunkLineNumber: number }
  | { type: "ended_patch" };

const VALID_HEADERS =
  "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

class ParserState {
  private mode: Mode = { type: "not_started" };
  private readonly hunks: Hunk[] = [];
  private lineNumber = 0;
  private environmentId: string | null = null;

  process(line: string): void {
    this.lineNumber += 1;
    this.processLine(line);
  }

  /**
   * 最后一行按 codex `finish()` 的语义处理：即使 `*** End Patch` 带前导空白，
   * 也直接收尾，而不是被 Update hunk 当作 context 行。
   */
  finishLastLine(line: string): Hunk[] {
    this.lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.mode = { type: "ended_patch" };
    } else {
      this.processLine(line);
    }
    return this.finish();
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    switch (this.mode.type) {
      case "not_started": {
        if (trimmed === BEGIN_PATCH_MARKER) {
          this.mode = { type: "started_patch" };
          return;
        }
        throw invalidPatch(
          `The first line of the patch must be '${BEGIN_PATCH_MARKER}'`,
        );
      }
      case "started_patch": {
        if (this.handleHeader(trimmed)) return;
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`,
          this.lineNumber,
        );
      }
      case "add_file": {
        if (this.handleHeader(trimmed)) return;
        if (line.startsWith("+")) {
          const hunk = this.hunks[this.mode.hunkIndex];
          if (hunk?.kind === "add") {
            hunk.contents += `${line.slice(1)}\n`;
            return;
          }
        }
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`,
          this.lineNumber,
        );
      }
      case "delete_file": {
        if (this.handleHeader(trimmed)) return;
        throw invalidHunk(
          `'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`,
          this.lineNumber,
        );
      }
      case "update_file": {
        this.processUpdateLine(line, this.mode);
        return;
      }
      case "ended_patch": {
        if (trimmed === "") return;
        throw invalidPatch(
          `The last line of the patch must be '${END_PATCH_MARKER}'`,
        );
      }
    }
  }

  finish(): Hunk[] {
    if (this.mode.type !== "ended_patch") {
      throw invalidPatch(
        `The last line of the patch must be '${END_PATCH_MARKER}'`,
      );
    }
    return this.hunks;
  }

  private lastUpdateHunk(): Extract<Hunk, { kind: "update" }> | null {
    const last = this.hunks[this.hunks.length - 1];
    return last?.kind === "update" ? last : null;
  }

  private ensureUpdateHunkIsNotEmpty(line: string): void {
    const hunk = this.lastUpdateHunk();
    if (!hunk) return;
    if (hunk.chunks.length === 0 && this.mode.type === "update_file") {
      throw invalidHunk(
        `Update file hunk for path '${hunk.path}' is empty`,
        this.mode.hunkLineNumber,
      );
    }
    const lastChunk = hunk.chunks[hunk.chunks.length - 1];
    if (
      lastChunk &&
      lastChunk.oldLines.length === 0 &&
      lastChunk.newLines.length === 0
    ) {
      if (line === END_PATCH_MARKER) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          this.lineNumber,
        );
      }
      throw invalidHunk(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber,
      );
    }
  }

  private handleHeader(trimmed: string): boolean {
    if (
      this.mode.type === "started_patch" &&
      trimmed.startsWith(ENVIRONMENT_ID_MARKER)
    ) {
      if (this.environmentId !== null) {
        throw invalidPatch(
          "apply_patch environment_id cannot be specified more than once",
        );
      }
      const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (environmentId === "") {
        throw invalidPatch("apply_patch environment_id cannot be empty");
      }
      this.environmentId = environmentId;
      return true;
    }

    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.mode = { type: "ended_patch" };
      return true;
    }

    const header = matchHunkHeader(trimmed);
    if (header) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      if (header.kind === "add") {
        this.hunks.push({ kind: "add", path: header.path, contents: "" });
        this.mode = { type: "add_file", hunkIndex: this.hunks.length - 1 };
      } else if (header.kind === "delete") {
        this.hunks.push({ kind: "delete", path: header.path });
        this.mode = { type: "delete_file", hunkIndex: this.hunks.length - 1 };
      } else {
        this.hunks.push({
          kind: "update",
          path: header.path,
          movePath: null,
          chunks: [],
        });
        this.mode = {
          type: "update_file",
          hunkIndex: this.hunks.length - 1,
          hunkLineNumber: this.lineNumber,
        };
      }
      return true;
    }

    return false;
  }

  private processUpdateLine(
    line: string,
    mode: Extract<Mode, { type: "update_file" }>,
  ): void {
    // Update hunk 内只裁尾部空白：以空格开头的“伪头部”必须按 context 行处理。
    const updateLine = line.trimEnd();
    if (this.handleHeader(updateLine)) return;

    const hunk = this.hunks[mode.hunkIndex];
    if (!hunk || hunk.kind !== "update") return;

    const lastChunk = hunk.chunks[hunk.chunks.length - 1];
    const anchor = ANCHOR_RE.exec(updateLine);
    if (lastChunk?.isEndOfFile) {
      if (updateLine === "") return;
      if (!anchor) {
        throw invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber,
        );
      }
    }

    const moveTo = MOVE_TO_RE.exec(updateLine);
    if (hunk.chunks.length === 0 && hunk.movePath === null && moveTo) {
      hunk.movePath = moveTo[1]!;
      this.mode = mode;
      return;
    }

    if (
      anchor &&
      lastChunk &&
      lastChunk.oldLines.length === 0 &&
      lastChunk.newLines.length === 0
    ) {
      throw invalidHunk(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber,
      );
    }

    if (anchor) {
      hunk.chunks.push(newChunk(anchor[1] ?? null));
      this.mode = mode;
      return;
    }

    if (updateLine === EOF_MARKER) {
      if (
        lastChunk &&
        lastChunk.oldLines.length === 0 &&
        lastChunk.newLines.length === 0
      ) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          this.lineNumber,
        );
      }
      if (lastChunk) lastChunk.isEndOfFile = true;
      this.mode = mode;
      return;
    }

    if (line === "") {
      if (hunk.chunks.length === 0) hunk.chunks.push(newChunk());
      pushContextLine(hunk.chunks[hunk.chunks.length - 1]!, "");
      this.mode = mode;
      return;
    }

    if (line.startsWith(" ")) {
      if (hunk.chunks.length === 0) hunk.chunks.push(newChunk());
      pushContextLine(hunk.chunks[hunk.chunks.length - 1]!, line.slice(1));
      this.mode = mode;
      return;
    }

    if (line.startsWith("+")) {
      if (hunk.chunks.length === 0) hunk.chunks.push(newChunk());
      hunk.chunks[hunk.chunks.length - 1]!.newLines.push(line.slice(1));
      this.mode = mode;
      return;
    }

    if (line.startsWith("-")) {
      if (hunk.chunks.length === 0) hunk.chunks.push(newChunk());
      hunk.chunks[hunk.chunks.length - 1]!.oldLines.push(line.slice(1));
      this.mode = mode;
      return;
    }

    if (
      lastChunk &&
      (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)
    ) {
      throw invalidHunk(
        `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        this.lineNumber,
      );
    }

    throw invalidHunk(
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      this.lineNumber,
    );
  }
}

function newChunk(changeContext: string | null = null): UpdateFileChunk {
  return {
    changeContext,
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
  };
}

function pushContextLine(chunk: UpdateFileChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

/** 解析完整补丁；错误以 ParseError 抛出，文案与 codex 保持一致。 */
export function parsePatch(patch: string): Hunk[] {
  const rawLines = splitPatchLines(patch);
  const first = rawLines[0]?.trim();
  const last = rawLines[rawLines.length - 1]?.trim();

  if (rawLines.length === 0) {
    throw invalidPatch(
      `The last line of the patch must be '${END_PATCH_MARKER}'`,
    );
  }
  if (first !== BEGIN_PATCH_MARKER) {
    throw invalidPatch(
      `The first line of the patch must be '${BEGIN_PATCH_MARKER}'`,
    );
  }
  if (last !== END_PATCH_MARKER) {
    throw invalidPatch(
      `The last line of the patch must be '${END_PATCH_MARKER}'`,
    );
  }

  const lines = stripSeparatorBlankLines(rawLines);
  const parser = new ParserState();
  for (const line of lines.slice(0, -1)) parser.process(line);
  return parser.finishLastLine(lines[lines.length - 1]!);
}
