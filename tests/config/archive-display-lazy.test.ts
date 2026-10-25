/**
 * R-3：历史页只按需读取涉及窗口的 display。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveWindow,
  hydrateArchivedDisplay,
  loadArchivedDisplaysForEntries,
} from "../../src/config/archive.js";
import { writeGzipJson } from "../../src/config/gzip-json.js";
import { createAssistantText } from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-archive-lazy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function entry(index: number): LogEntry {
  return createAssistantText(`a-${index}`, 1, 0, `display-${index}`, `display-${index}`);
}

/** 写入窗口后把内存条目改成历史页拿到的形态（archived + display 空）。 */
function seedWindow(dir: string, window: number, item: LogEntry): void {
  archiveWindow(dir, window, [item], 0, 0);
  item.archived = true;
  item.display = "";
}

function archivedEntry(index: number): LogEntry {
  const item = entry(index);
  item.archived = true;
  item.display = "";
  return item;
}

describe("归档 display 按窗口懒读", () => {
  it("只读取目标条目所在窗口", () => {
    const dir = makeDir();
    const a = entry(0);
    const b = entry(1);
    seedWindow(dir, 0, a);
    seedWindow(dir, 1, b);
    // 旁边存在一个没有索引的旧窗口：新条目已能被 entryIds 定位，不应被它拖累。
    writeGzipJson(join(dir, "archive", "window-9.json.gz"), [
      { id: "a-old", content: "old", display: "old", meta: {} },
    ]);

    const onlyA = loadArchivedDisplaysForEntries(dir, [a]);
    expect(onlyA.windowsRead).toEqual([0]);
    expect(onlyA.displays.get("a-0")).toBe("display-0");
    expect(onlyA.displays.has("a-1")).toBe(false);

    const both = loadArchivedDisplaysForEntries(dir, [a, b]);
    expect(both.windowsRead).toEqual([0, 1]);
    expect(both.displays.size).toBe(2);
  });

  it("旧窗口没有索引时兜底读取，仍能取回 display", () => {
    const dir = makeDir();
    const c = archivedEntry(2);
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeGzipJson(join(dir, "archive", "window-2.json.gz"), [
      { id: "a-2", content: "display-2", display: "display-2", meta: {} },
    ]);

    const lookup = loadArchivedDisplaysForEntries(dir, [c]);
    expect(lookup.windowsRead).toEqual([2]);
    expect(lookup.displays.get("a-2")).toBe("display-2");
  });

  it("hydrateArchivedDisplay 复用同一按需路径", () => {
    const dir = makeDir();
    const a = entry(0);
    const b = entry(1);
    seedWindow(dir, 0, a);
    seedWindow(dir, 1, b);

    expect(hydrateArchivedDisplay(dir, [a, b])).toBe(2);
    expect(a.display).toBe("display-0");
    expect(b.display).toBe("display-1");
  });
});
