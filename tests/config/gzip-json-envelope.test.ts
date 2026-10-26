import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readGzipJsonlEnvelope,
  readGzipJsonlEnvelopeIndexAsync,
  readGzipJsonlEnvelopeSelectedAsync,
  writeGzipJsonlEnvelopeAtomic,
} from "../../src/config/gzip-json.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-archive-envelope-"));
  dirs.push(dir);
  return dir;
}

describe("gzip JSONL archive envelope", () => {
  it("streams entries between one header and one trailer index", async () => {
    const dir = makeDir();
    const file = join(dir, "window-cp-1.jsonl.gz");
    let yielded = 0;
    function* entries() {
      for (let i = 0; i < 128; i += 1) {
        yielded += 1;
        yield { id: `e-${i}`, content: `body-${i}`, display: `display-${i}`, meta: {} };
      }
    }

    await writeGzipJsonlEnvelopeAtomic(file, "cp-1", entries(), {
      entryIds: Array.from({ length: 128 }, (_, i) => `e-${i}`),
      turns: [],
      mutations: [],
    });

    expect(yielded).toBe(128);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["window-cp-1.jsonl.gz"]);
    expect(readGzipJsonlEnvelope<{ id: string }, { entryIds: string[] }>(file)).toEqual({
      checkpointId: "cp-1",
      entries: Array.from({ length: 128 }, (_, i) => ({
        id: `e-${i}`,
        content: `body-${i}`,
        display: `display-${i}`,
        meta: {},
      })),
      index: { entryIds: Array.from({ length: 128 }, (_, i) => `e-${i}`), turns: [], mutations: [] },
    });
  });

  it("streams an index without materializing entries", async () => {
    const dir = makeDir();
    const file = join(dir, "window-cp-index.jsonl.gz");
    const entries = Array.from({ length: 256 }, (_, i) => ({
      id: `e-${i}`,
      content: "x".repeat(1024),
      display: `display-${i}`,
      meta: {},
    }));
    const index = { entryIds: entries.map((entry) => entry.id), turns: [], mutations: [] };

    await writeGzipJsonlEnvelopeAtomic(file, "cp-index", entries, index);

    await expect(readGzipJsonlEnvelopeIndexAsync<typeof index>(file)).resolves.toEqual({
      checkpointId: "cp-index",
      index,
    });
    await expect(readGzipJsonlEnvelopeSelectedAsync<typeof entries[number], typeof index>(
      file,
      (entry) => entry.id === "e-127",
    )).resolves.toMatchObject({
      checkpointId: "cp-index",
      index,
      entries: [entries[127]],
    });
  });

  it("wraps a missing archive read as a rejected promise", async () => {
    const dir = makeDir();
    await expect(readGzipJsonlEnvelopeIndexAsync(join(dir, "missing.jsonl.gz")))
      .rejects.toThrow(/ENOENT/);
  });

  it("removes its temporary file when serialization fails", async () => {
    const dir = makeDir();
    const file = join(dir, "window-cp-bad.jsonl.gz");

    await expect(writeGzipJsonlEnvelopeAtomic(file, "cp-bad", [{ value: 1n }], {}))
      .rejects.toThrow();

    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
