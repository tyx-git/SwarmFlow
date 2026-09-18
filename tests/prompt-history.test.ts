import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPromptHistoryForTesting,
  appendPromptHistory,
  getPromptHistoryNavigationDirection,
  navigatePromptHistory,
} from "../external/opentui/input/prompt-history.js";

function readJsonl(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

describe("prompt-history", () => {
  let homeDir: string;
  let stateFile: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "swarmflow-prompt-history-"));
    stateFile = join(homeDir, "state", "prompt-history.jsonl");
    __resetPromptHistoryForTesting(homeDir);
  });

  afterEach(() => {
    __resetPromptHistoryForTesting(null);
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("creates file and writes one entry", () => {
      appendPromptHistory("hello");
      expect(existsSync(stateFile)).toBe(true);
      expect(readJsonl(stateFile)).toEqual([JSON.stringify({ input: "hello" })]);
    });

    it("appends additional entries", () => {
      appendPromptHistory("a");
      appendPromptHistory("b");
      appendPromptHistory("c");
      expect(readJsonl(stateFile).map((l) => JSON.parse(l).input)).toEqual(["a", "b", "c"]);
    });

    it("skips empty input", () => {
      appendPromptHistory("");
      expect(existsSync(stateFile)).toBe(false);
    });

    it("skips slash commands", () => {
      appendPromptHistory("/help");
      appendPromptHistory("/model gpt-5");
      appendPromptHistory("/fork");
      expect(existsSync(stateFile)).toBe(false);
    });

    it("does not affect interleaved real prompts", () => {
      appendPromptHistory("hello");
      appendPromptHistory("/copy");
      appendPromptHistory("world");
      expect(readJsonl(stateFile).map((l) => JSON.parse(l).input)).toEqual(["hello", "world"]);
    });

    it("slash command submission resets navigation index", () => {
      appendPromptHistory("a");
      appendPromptHistory("b");
      // User walks back into history.
      expect(navigatePromptHistory(-1, "")).toBe("b");
      expect(navigatePromptHistory(-1, "b")).toBe("a");
      // Submitting a slash command should reset just like a normal submit.
      appendPromptHistory("/help");
      expect(navigatePromptHistory(-1, "")).toBe("b");
    });

    it("dedupes when identical to most recent", () => {
      appendPromptHistory("ls");
      appendPromptHistory("ls");
      appendPromptHistory("ls");
      expect(readJsonl(stateFile).length).toBe(1);
    });

    it("does NOT dedupe when separated by another entry", () => {
      appendPromptHistory("a");
      appendPromptHistory("b");
      appendPromptHistory("a");
      expect(readJsonl(stateFile).map((l) => JSON.parse(l).input)).toEqual(["a", "b", "a"]);
    });

    it("trims to 200 entries (keeps newest)", () => {
      for (let i = 0; i < 250; i++) appendPromptHistory(`p${i}`);
      const lines = readJsonl(stateFile);
      expect(lines.length).toBe(200);
      expect(JSON.parse(lines[0]).input).toBe("p50");
      expect(JSON.parse(lines[199]).input).toBe("p249");
    });
  });

  describe("key boundary routing", () => {
    it("only routes ↑ to history at the absolute start", () => {
      expect(getPromptHistoryNavigationDirection({
        keyName: "up",
        cursorOffset: 0,
        textDisplayWidth: 8,
      })).toBe(-1);
      expect(getPromptHistoryNavigationDirection({
        keyName: "up",
        cursorOffset: 1,
        textDisplayWidth: 8,
      })).toBe(undefined);
    });

    it("only routes ↓ to history at the absolute end", () => {
      expect(getPromptHistoryNavigationDirection({
        keyName: "down",
        cursorOffset: 8,
        textDisplayWidth: 8,
      })).toBe(1);
      expect(getPromptHistoryNavigationDirection({
        keyName: "down",
        cursorOffset: 7,
        textDisplayWidth: 8,
      })).toBe(undefined);
    });

    it("does not route history while a child tab is selected", () => {
      expect(getPromptHistoryNavigationDirection({
        keyName: "up",
        cursorOffset: 0,
        textDisplayWidth: 8,
        selectedChildId: "child-1",
      })).toBe(undefined);
      expect(getPromptHistoryNavigationDirection({
        keyName: "down",
        cursorOffset: 8,
        textDisplayWidth: 8,
        selectedChildId: "child-1",
      })).toBe(undefined);
    });

    it("ignores non-arrow keys", () => {
      expect(getPromptHistoryNavigationDirection({
        keyName: "left",
        cursorOffset: 0,
        textDisplayWidth: 0,
      })).toBe(undefined);
    });
  });

  describe("load + self-heal", () => {
    it("loads existing entries on first navigation", () => {
      mkdirSync(join(homeDir, "state"), { recursive: true });
      writeFileSync(
        stateFile,
        [JSON.stringify({ input: "x" }), JSON.stringify({ input: "y" })].join("\n") + "\n",
      );
      __resetPromptHistoryForTesting(homeDir);
      expect(navigatePromptHistory(-1, "")).toBe("y");
      expect(navigatePromptHistory(-1, "y")).toBe("x");
    });

    it("drops malformed lines and rewrites file", () => {
      mkdirSync(join(homeDir, "state"), { recursive: true });
      const raw = [
        JSON.stringify({ input: "good1" }),
        "{not valid json",
        JSON.stringify({ input: "good2" }),
        JSON.stringify({ notInputField: 42 }),
      ].join("\n") + "\n";
      writeFileSync(stateFile, raw);
      __resetPromptHistoryForTesting(homeDir);

      // Trigger lazy load via navigate.
      expect(navigatePromptHistory(-1, "")).toBe("good2");

      // After self-heal, only the two valid entries remain.
      const lines = readJsonl(stateFile);
      expect(lines).toEqual([
        JSON.stringify({ input: "good1" }),
        JSON.stringify({ input: "good2" }),
      ]);
    });

    it("returns undefined when file is missing", () => {
      __resetPromptHistoryForTesting(homeDir);
      expect(navigatePromptHistory(-1, "")).toBe(undefined);
      expect(navigatePromptHistory(1, "")).toBe(undefined);
    });
  });

  describe("navigate (方案 2)", () => {
    beforeEach(() => {
      // history = ["A", "B", "C"] (oldest → newest)
      appendPromptHistory("A");
      appendPromptHistory("B");
      appendPromptHistory("C");
    });

    it("walks backward from empty draft", () => {
      expect(navigatePromptHistory(-1, "")).toBe("C");
      expect(navigatePromptHistory(-1, "C")).toBe("B");
      expect(navigatePromptHistory(-1, "B")).toBe("A");
    });

    it("returns undefined past oldest", () => {
      navigatePromptHistory(-1, "");
      navigatePromptHistory(-1, "C");
      navigatePromptHistory(-1, "B");
      expect(navigatePromptHistory(-1, "A")).toBe(undefined);
    });

    it("returns undefined past draft slot", () => {
      expect(navigatePromptHistory(1, "")).toBe(undefined);
    });

    it("captures liveDraft on first ↑ and restores on return to draft slot", () => {
      // User has typed "draft" then presses ↑
      expect(navigatePromptHistory(-1, "draft")).toBe("C");
      expect(navigatePromptHistory(-1, "C")).toBe("B");
      // ↓ back twice should restore draft
      expect(navigatePromptHistory(1, "B")).toBe("C");
      expect(navigatePromptHistory(1, "C")).toBe("draft");
      // Past draft slot bounded
      expect(navigatePromptHistory(1, "draft")).toBe(undefined);
    });

    it("loses edits made to a recalled entry (方案 2 semantics)", () => {
      navigatePromptHistory(-1, ""); // → C
      // User edits "C" to "C-modified", then ↑ navigates onward, edit is dropped
      expect(navigatePromptHistory(-1, "C-modified")).toBe("B");
      // ↓ back goes through C (the original), not the modified text
      expect(navigatePromptHistory(1, "B")).toBe("C");
    });

    it("liveDraft survives a no-edit round trip", () => {
      expect(navigatePromptHistory(-1, "my draft")).toBe("C");
      expect(navigatePromptHistory(1, "C")).toBe("my draft");
    });

    it("captures liveDraft only on first entry, not on re-entry", () => {
      // First entry: liveDraft = "first"
      expect(navigatePromptHistory(-1, "first")).toBe("C");
      // ↓ back to draft → "first"
      expect(navigatePromptHistory(1, "C")).toBe("first");
      // Second entry from a different draft "second" — should overwrite liveDraft
      expect(navigatePromptHistory(-1, "second")).toBe("C");
      expect(navigatePromptHistory(1, "C")).toBe("second");
    });

    it("append after navigation resets index and clears liveDraft", () => {
      navigatePromptHistory(-1, "draft"); // → C, liveDraft = "draft"
      appendPromptHistory("D");
      // Pressing ↑ now should give the newest "D", not continue from -1
      expect(navigatePromptHistory(-1, "")).toBe("D");
      // ↓ back to draft slot — should be "" not the old "draft"
      expect(navigatePromptHistory(1, "D")).toBe("");
    });
  });

  describe("re-entry preserves position (方案 2)", () => {
    beforeEach(() => {
      appendPromptHistory("A");
      appendPromptHistory("B");
      appendPromptHistory("C");
    });

    it("↓ at end after edit walks forward from preserved index", () => {
      // User types "draft", ↑ to C, ↑ to B. Then edits "B" → "B改" while
      // still at index=-2. Position must be preserved: ↓ should reach C, not
      // be stuck at the draft slot.
      navigatePromptHistory(-1, "draft"); // → C, liveDraft = "draft"
      navigatePromptHistory(-1, "C");     // → B, index = -2
      // (App-level mode would have exited after the edit; the next ↓ at end
      // re-enters by calling navigate with the edited text.)
      expect(navigatePromptHistory(1, "B改")).toBe("C");
    });

    it("↑ at start after edit walks backward from preserved index", () => {
      navigatePromptHistory(-1, "draft");
      navigatePromptHistory(-1, "C");     // → B, index = -2
      expect(navigatePromptHistory(-1, "B改")).toBe("A");
    });

    it("walking all the way back restores original liveDraft, not edits", () => {
      // 方案 2: edits to a recalled entry are lost on next nav; the original
      // captured liveDraft is what comes back at index=0.
      navigatePromptHistory(-1, "draft"); // captures liveDraft="draft", → C
      navigatePromptHistory(-1, "C-edited"); // → B (edit dropped)
      navigatePromptHistory(1, "B-edited");  // → C (edit dropped)
      expect(navigatePromptHistory(1, "C")).toBe("draft");
    });
  });
});
