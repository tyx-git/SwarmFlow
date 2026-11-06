import { describe, expect, it } from "vitest";

import { splitTaskHandoffForDisplay } from "../../external/opentui/presentation/handoff-blocks.js";

/**
 * 机器交接块的展示拆分契约（原先挂在 src/swarm/task-handoff.ts，随编排层删除搬到这里）。
 * 只断言可观察的展示文本与摘要，不锁实现。
 */
describe("handoff display splitter", () => {
  const block = (payload: string): string => [
    "```swarmflow-handoff",
    payload,
    "```",
  ].join("\n");

  it("strips a complete block and returns its conclusion", () => {
    const result = splitTaskHandoffForDisplay(`report\n\n${block(JSON.stringify({
      conclusion: "done",
      modified_files: [],
      test_results: [],
      risks: [],
      open_questions: [],
    }))}`);
    expect(result.displayText).toBe("report");
    expect(result.conclusion).toBe("done");
    expect(result.hadBlock).toBe(true);
  });

  it("removes every block and uses the last valid conclusion", () => {
    const first = block(JSON.stringify({ conclusion: "first" }));
    const second = block(JSON.stringify({ conclusion: "second" }));
    const result = splitTaskHandoffForDisplay(`a\n\n${first}\n\nmiddle\n\n${second}\n\ntail`);
    expect(result.displayText).toBe("a\n\nmiddle\n\ntail");
    expect(result.conclusion).toBe("second");
  });

  it("hides invalid and incomplete blocks without inventing a conclusion", () => {
    const invalid = block("{not-json");
    expect(splitTaskHandoffForDisplay(`report\n${invalid}`)).toMatchObject({
      displayText: "report",
      conclusion: undefined,
      hadBlock: true,
    });

    const unclosed = "report\n```swarmflow-handoff\n{\"conclusion\":\"partial\"}";
    expect(splitTaskHandoffForDisplay(unclosed)).toMatchObject({
      displayText: "report",
      conclusion: undefined,
      hadBlock: true,
    });
  });

  it("accepts a conclusion-only root block", () => {
    const result = splitTaskHandoffForDisplay(block(JSON.stringify({ conclusion: "root summary" })));
    expect(result.displayText).toBe("");
    expect(result.conclusion).toBe("root summary");
  });

  it("strips leading BOMs and normalizes conclusion whitespace", () => {
    const bom = String.fromCharCode(0xfeff);
    const result = splitTaskHandoffForDisplay(`${bom}${block(JSON.stringify({
      conclusion: "line one\n  line two",
    }))}`);
    expect(result.displayText).toBe("");
    expect(result.conclusion).toBe("line one line two");
  });
});
