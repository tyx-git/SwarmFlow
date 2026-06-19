/**
 * file-modify detail-tab 渲染热路径的微基准测试。
 *
 * 复现一次大型 `write_file` 详情视图的流式重建开销，并对比：
 *   - 完全物化（旧行为：每个可见行都高亮+构建）
 *     vs 窗口物化（虚拟化详情：仅视口内行）
 *   - 冷高亮缓存（首次看见一行）vs 热缓存（重新渲染未改动的行，
 *     即首次之后的每个流式增量）
 *
 * 运行：bun scripts/bench-file-modify-render.ts
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
const WINDOW = 50; // 典型视口 + 缓冲
const ITERS = 200; // 模拟的流式重建次数

function writeData(seed: string): FileModifyDisplayData {
  const writeLines: string[] = [];
  for (let i = 0; i < LINES; i++) {
    writeLines.push(`export const ${seed}_${i} = (x: number): string => \`row \${x + ${i}}\`; // ${seed} ${i}`);
  }
  return { filePath: "src/big.ts", language: "typescript", mode: "write", totalLineCount: LINES, writeLines };
}

function bench(label: string, fn: () => void, iters: number): void {
  // 预热
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

  // 冷缓存：每次重建都高亮全新的行文本（每行都缓存未命中）。
  let coldSeed = 0;
  bench("FULL materialize, COLD cache (400 rows)", () => {
    const d = buildLineDescriptors(writeData(`cold${coldSeed++}`), COLORS);
    materializeDescriptors(d, COLORS, WIDTH, 0, d.length);
  }, 40);

  // 热缓存：相同的描述符重新物化（稳定行的流式重渲染）。
  bench("FULL materialize, WARM cache (400 rows)", () => {
    materializeDescriptors(descriptors, COLORS, WIDTH, 0, descriptors.length);
  }, ITERS);

  // 虚拟化：每次重建仅物化视口窗口。
  bench("WINDOWED materialize, WARM cache (50 rows)", () => {
    const start = 175;
    materializeDescriptors(descriptors, COLORS, WIDTH, start, start + WINDOW);
  }, ITERS);

  // 仅结构遍历（无论是否窗口化，每次重建都运行）。
  bench("buildLineDescriptors only (no highlight)", () => {
    buildLineDescriptors(data, COLORS);
  }, ITERS);
}

main().catch((e) => { console.error(e); process.exit(1); });
