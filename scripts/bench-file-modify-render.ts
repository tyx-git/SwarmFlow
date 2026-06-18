/**
 * Microbench for the file-modify detail-tab render hot path.
 *
 * Reproduces the cost of one streaming rebuild of a large `write_file` detail
 * view and contrasts:
 *   - full materialize (old behaviour: every visible row highlighted+built)
 *     vs windowed materialize (virtualized detail: only viewport rows)
 *   - cold highlight cache (first time a line is seen) vs warm (re-render of
 *     unchanged lines, i.e. every streaming delta after the first)
 *
 * Run: bun scripts/bench-file-modify-render.ts
 */

import {
  buildLineDescriptors,
  materializeDescriptors,
} from "../external/opentui/components/entry/file-modify-body.js";
import { initShikiHighlighter, setShikiTheme } from "../external/opentui/forked/shiki-highlighter.js";
import type { FileModifyDisplayData } from "../src/diff-hunk.js";
import type { ConversationPalette } from "../external/opentui/components/conversation-types.js";

const COLORS = {
  text: "#d0d6e0", dim: "#636a76", red: "#f05030", green: "#73a942", border: "#2a2630",
} as unknown as ConversationPalette;

const WIDTH = 100;
const LINES = 400;
const WINDOW = 50; // typical viewport + buffer
const ITERS = 200; // streaming rebuilds to simulate

function writeData(seed: string): FileModifyDisplayData {
  const writeLines: string[] = [];
  for (let i = 0; i < LINES; i++) {
    writeLines.push(`export const ${seed}_${i} = (x: number): string => \`row \${x + ${i}}\`; // ${seed} ${i}`);
  }
  return { filePath: "src/big.ts", language: "typescript", mode: "write", totalLineCount: LINES, writeLines };
}

function bench(label: string, fn: () => void, iters: number): void {
  // warmup
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = performance.now() - t0;
  console.log(`${label.padEnd(42)} ${(dt / iters).toFixed(3)} ms/rebuild  (${iters}x → ${dt.toFixed(0)} ms)`);
}

async function main(): Promise<void> {
  await initShikiHighlighter();
  setShikiTheme("dark");

  const data = writeData("stable");
  const descriptors = buildLineDescriptors(data, COLORS);
  console.log(`descriptors: ${descriptors.length} rows, language=typescript, width=${WIDTH}\n`);

  // Cold cache: each rebuild highlights brand-new line text (cache miss every line).
  let coldSeed = 0;
  bench("FULL materialize, COLD cache (400 rows)", () => {
    const d = buildLineDescriptors(writeData(`cold${coldSeed++}`), COLORS);
    materializeDescriptors(d, COLORS, WIDTH, 0, d.length);
  }, 40);

  // Warm cache: same descriptors re-materialized (streaming re-render of stable lines).
  bench("FULL materialize, WARM cache (400 rows)", () => {
    materializeDescriptors(descriptors, COLORS, WIDTH, 0, descriptors.length);
  }, ITERS);

  // Virtualized: only the viewport window is materialized each rebuild.
  bench("WINDOWED materialize, WARM cache (50 rows)", () => {
    const start = 175;
    materializeDescriptors(descriptors, COLORS, WIDTH, start, start + WINDOW);
  }, ITERS);

  // Structural pass alone (runs every rebuild regardless of windowing).
  bench("buildLineDescriptors only (no highlight)", () => {
    buildLineDescriptors(data, COLORS);
  }, ITERS);
}

main().catch((e) => { console.error(e); process.exit(1); });
