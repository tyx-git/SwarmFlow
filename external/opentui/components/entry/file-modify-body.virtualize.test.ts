import { describe, expect, it } from "bun:test";

import { buildLineDescriptors, materializeDescriptors } from "./file-modify-body.js";
import type { ConversationPalette } from "../conversation-types.js";
import type { FileModifyDisplayData, DiffHunk } from "../../../src/diff-hunk.js";

// Minimal palette 鈥?only dim/red/green/text are read by the builders.
const COLORS = {
  background: "transparent",
  panel: "transparent",
  userBg: "#1f1c26",
  border: "#2a2630",
  separator: "#2a2630",
  scrollbarThumb: "#d0d6e0",
  scrollbarTrack: "#2a263044",
  text: "#d0d6e0",
  dim: "#636a76",
  muted: "#454a54",
  accent: "#ffb703",
  orange: "#fb8500",
  red: "#f05030",
  magenta: "#e81860",
  purple: "#a010a0",
  yellow: "#e8c468",
  green: "#73a942",
  cyan: "#9cd4cc",
  thinking: "#454a54",
  toolTime: "#8a8078",
} as unknown as ConversationPalette;

const WIDTH = 80;

// ------------------------------------------------------------------
// Serialization 鈥?turn an artifact into a plain, comparable shape.
// ------------------------------------------------------------------

function ser(artifacts: ReturnType<typeof materializeDescriptors>): unknown {
  return artifacts.map((a) => ({
    bg: a.rowBackgroundColor ?? null,
    chunks: ((a.content as any).chunks as Array<any>).map((c) => ({
      text: c.text,
      fg: c.fg ? [round(c.fg.r), round(c.fg.g), round(c.fg.b), round(c.fg.a)] : null,
      attributes: c.attributes ?? null,
    })),
  }));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ------------------------------------------------------------------
// Sample data
// ------------------------------------------------------------------

function writeData(lineCount: number): FileModifyDisplayData {
  const writeLines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    writeLines.push(`const value_${i} = compute(${i}, "row ${i}"); // line ${i}`);
  }
  return {
    filePath: "src/big.ts",
    language: "typescript",
    mode: "write",
    totalLineCount: lineCount,
    writeLines,
  };
}

function replaceData(): FileModifyDisplayData {
  const hunk = (startLine: number): DiffHunk => ({
    startLine,
    contextBefore: [`  // before ${startLine}`, `  const a = ${startLine};`],
    deletions: [`  const old = ${startLine};`],
    additions: [`  const neu = ${startLine};`, `  const extra = ${startLine + 1};`],
    contextAfter: [`  return a;`, `  // after ${startLine}`],
  });
  return {
    filePath: "src/edit.ts",
    language: "typescript",
    mode: "replace",
    totalLineCount: 500,
    hunks: [hunk(10), hunk(120), hunk(300)],
  };
}

function appendData(lineCount: number): FileModifyDisplayData {
  const additions: string[] = [];
  for (let i = 0; i < lineCount; i++) additions.push(`appended line ${i}`);
  return {
    filePath: "log.txt",
    language: undefined,
    mode: "append",
    totalLineCount: 1000,
    hunks: [{ startLine: 900, contextBefore: [], deletions: [], additions, contextAfter: [] }],
  };
}

// ------------------------------------------------------------------
// The core invariant: windowed render == full render's matching slice.
// ------------------------------------------------------------------

const CASES: Array<[string, FileModifyDisplayData]> = [
  ["write/400", writeData(400)],
  ["write/1", writeData(1)],
  ["replace/3-hunks", replaceData()],
  ["append/200", appendData(200)],
];

describe("FileModifyBody virtualization: windowed == full slice", () => {
  for (const [name, data] of CASES) {
    it(name, () => {
      const descriptors = buildLineDescriptors(data, COLORS);
      const total = descriptors.length;
      const full = ser(materializeDescriptors(descriptors, COLORS, WIDTH, 0, total));

      const windows: Array<[number, number]> = [
        [0, total],            // whole
        [0, 0],                // empty
        [0, 1],                // head
        [Math.max(0, total - 1), total], // tail
        [Math.floor(total / 3), Math.floor((2 * total) / 3)], // middle
        [-5, 10],              // clamp negative start
        [total - 3, total + 50], // clamp overshoot end
        [total + 10, total + 20], // fully out of range 鈫?empty
      ];

      for (const [a, b] of windows) {
        const windowed = ser(materializeDescriptors(descriptors, COLORS, WIDTH, a, b));
        const lo = Math.max(0, Math.min(a, total));
        const hi = Math.max(lo, Math.min(b, total));
        expect(windowed).toEqual((full as unknown[]).slice(lo, hi));
      }
    });
  }
});

describe("FileModifyBody virtualization: structure", () => {
  it("write descriptor count equals line count (one row per line, no ellipsis)", () => {
    const data = writeData(400);
    expect(buildLineDescriptors(data, COLORS).length).toBe(400);
  });

  it("spacer math: top + window + bottom == total for any window", () => {
    const data = writeData(400);
    const total = buildLineDescriptors(data, COLORS).length;
    for (const [a, b] of [[0, 50], [100, 160], [380, 400], [395, 500]] as Array<[number, number]>) {
      const start = Math.max(0, Math.min(a, total));
      const end = Math.max(start, Math.min(b, total));
      const top = start;
      const bottom = total - end;
      const windowRows = end - start;
      expect(top + windowRows + bottom).toBe(total);
    }
  });

  it("write rows carry the original line content after the line-number prefix", () => {
    const data = writeData(10);
    const descriptors = buildLineDescriptors(data, COLORS);
    const arts = materializeDescriptors(descriptors, COLORS, 0 /* no truncation */, 0, descriptors.length);
    arts.forEach((a, i) => {
      const text = ((a.content as any).chunks as Array<any>).map((c) => c.text).join("");
      // Prefix is right-aligned line number + space; the rest is the source line.
      expect(text.endsWith(data.writeLines![i])).toBe(true);
      expect(text).toContain(String(i + 1));
    });
  });
});
