import React from "react";
import { describe, expect, it } from "vitest";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";

import { ToolOperationEntry } from "../../external/opentui/components/entry/tool-operation-entry.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { presentationTransform } from "../../external/opentui/presentation/transform.js";
import type { PresentationEntry } from "../../external/opentui/presentation/types.js";
import type { ReconciledConversationEntry } from "../../external/opentui/transcript/types.js";
import type { FileModifyDisplayData } from "../../src/patches/hunk.js";

const PATCH = [
  "*** Begin Patch",
  "*** Add File: a.txt",
  "+hello",
  "*** End Patch",
].join("\n");

function reconciled(
  id: string,
  entry: ReconciledConversationEntry["entry"],
): ReconciledConversationEntry {
  return { id, entry, contentVersion: 1 };
}

function addData(filePath: string, line: string): FileModifyDisplayData {
  return {
    filePath,
    mode: "write",
    totalLineCount: 0,
    hunks: [],
    writeLines: [line],
  };
}

function transform(
  assistantText: string,
  patchFiles: Array<{ kind: "A" | "M" | "D"; path: string; from?: string }>,
  fileModifyDataList: FileModifyDisplayData[],
  withEditCall = true,
): PresentationEntry[] {
  const entries: ReconciledConversationEntry[] = [
    reconciled("asst", { id: "asst", kind: "assistant", text: assistantText }),
  ];
  if (withEditCall) {
    entries.push(
      reconciled("call", {
        id: "call",
        kind: "tool_call",
        text: "edit",
        meta: {
          toolCallId: "call-1",
          toolName: "edit",
          toolArgs: {},
          toolExecState: "completed",
        },
      }),
      reconciled("result", {
        id: "result",
        kind: "tool_result",
        text: "Success. Updated the following files:\nA a.txt",
        meta: {
          toolCallId: "call-1",
          toolName: "edit",
          isError: false,
          toolMetadata: { patchFiles, fileModifyDataList },
        },
      }),
    );
  }
  return presentationTransform(entries, [], false, null);
}

describe("edit patch presentation", () => {
  it("strips a complete patch block when the same round calls edit", () => {
    const result = transform(`Applying.\n${PATCH}`, [{ kind: "A", path: "a.txt" }], [addData("a.txt", "hello")]);
    const assistant = result.find((entry) => entry.kind === "assistant");
    expect(assistant?.assistantText).toBe("Applying.");
    expect(assistant?.assistantText).not.toContain("*** Begin Patch");

    const operation = result.find((entry) => entry.kind === "tool_operation")!;
    expect(operation.toolDisplayName).toBe("Edit");
    expect(operation.toolText).toBe("a.txt");
    expect(operation.toolSuffix).toBe("(+1 -0)");
    expect(operation.patchFiles).toEqual([{ kind: "A", path: "a.txt" }]);
    expect(operation.fileModifyDataList).toHaveLength(1);
  });

  it("keeps the patch visible when the model forgot the edit call", () => {
    const result = transform(`Applying.\n${PATCH}`, [], [], false);
    const assistant = result.find((entry) => entry.kind === "assistant");
    expect(assistant?.assistantText).toContain("*** Begin Patch");
    expect(result.some((entry) => entry.kind === "tool_operation")).toBe(false);
  });

  it("removes surrounding code fences together with the patch block", () => {
    const fenced = `Applying.\n\`\`\`patch\n${PATCH}\n\`\`\``;
    const result = transform(fenced, [{ kind: "A", path: "a.txt" }], [addData("a.txt", "hello")]);
    const assistant = result.find((entry) => entry.kind === "assistant");
    expect(assistant?.assistantText).toBe("Applying.");
    expect(assistant?.assistantText).not.toContain("```");
  });

  it("summarises multiple files and leaves the path out of the tool line", () => {
    const result = transform(
      `Two files.\n${PATCH}`,
      [{ kind: "A", path: "a.txt" }, { kind: "A", path: "b.txt" }],
      [addData("a.txt", "one"), addData("b.txt", "two")],
    );
    const operation = result.find((entry) => entry.kind === "tool_operation")!;
    expect(operation.toolText).toBe("");
    expect(operation.toolSuffix).toBe("(2 files, +2 -0)");
    expect(operation.fileModifyDataList).toHaveLength(2);
  });

  it("labels a move with source and destination", () => {
    const result = transform(
      `Move.\n${PATCH}`,
      [{ kind: "M", path: "new.txt", from: "old.txt" }],
      [addData("new.txt", "moved")],
    );
    const operation = result.find((entry) => entry.kind === "tool_operation")!;
    expect(operation.toolText).toBe("");
    expect(operation.patchFiles).toEqual([
      { kind: "M", path: "new.txt", from: "old.txt" },
    ]);
  });

  it("renders one labelled card per changed file", async () => {
    const result = transform(
      `Two files.\n${PATCH}`,
      [{ kind: "A", path: "a.txt" }, { kind: "A", path: "b.txt" }],
      [addData("a.txt", "one"), addData("b.txt", "two")],
    );
    const operation = result.find((entry) => entry.kind === "tool_operation")!;
    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({
      width: 60,
      height: 18,
      useThread: false,
      consoleMode: "disabled",
    });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(ToolOperationEntry as any, {
        entry: operation,
        colors: theme.colors,
        theme,
        contentWidth: 56,
        diffDisplayMode: "compact",
      })));
      await setup.flush({ maxPasses: 100 });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Edit");
      expect(frame).toContain("A a.txt");
      expect(frame).toContain("A b.txt");
      expect(frame).toContain("one");
      expect(frame).toContain("two");
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });
});
