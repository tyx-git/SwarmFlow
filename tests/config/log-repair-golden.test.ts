/**
 * R-5/D7：repair 等价性 golden（变更前捕获，不保留旧实现）。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateAndRepairLog } from "../../src/config/log-repair.js";
import {
  createAssistantText,
  createReasoning,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

interface GoldenFixture {
  name: string;
  input: LogEntry[];
  output: {
    entries: LogEntry[];
    repaired: boolean;
    warnings: string[];
  };
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/log-repair-golden.json", import.meta.url), "utf-8"),
) as { fixtures: GoldenFixture[] };

describe("validateAndRepairLog golden", () => {
  for (const fixture of golden.fixtures) {
    it(fixture.name, () => {
      const input = structuredClone(fixture.input);
      const result = validateAndRepairLog(input);
      expect(result.entries).toEqual(fixture.output.entries);
      expect(result.repaired).toBe(fixture.output.repaired);
      expect(result.warnings).toEqual(fixture.output.warnings);
    });
  }

  it("同 turn 不同 round 不算 own action（组合键）", () => {
    const input = [
      createReasoning("r-same-turn", 1, 2, "r", "r"),
      createAssistantText("a-same-turn-other-round", 1, 1, "a", "a"),
      createAssistantText("a-other-turn-same-round", 2, 2, "a", "a"),
    ];
    const result = validateAndRepairLog(input);
    expect(result.entries[0]?.turnIndex).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
