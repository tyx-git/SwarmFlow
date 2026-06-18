import { describe, expect, it } from "bun:test";
import { rewindOptions } from "../src/commands.js";
import { acceptCommandPickerSelection, createCommandPicker } from "../src/ui/command-picker.js";

describe("rewind command picker", () => {
  it("renders a Message/Changes header, current marker, and newest-first targets", () => {
    const options = rewindOptions({
      session: {
        getRewindTargets: () => [
          {
            turnIndex: 3,
            entryIndex: 30,
            preview: "Newest request",
            timestamp: 3,
            fileCount: 3,
            additions: 17,
            deletions: 30,
            filesReverted: false,
          },
          {
            turnIndex: 2,
            entryIndex: 20,
            preview: "Older request",
            timestamp: 2,
            fileCount: 1,
            additions: 0,
            deletions: 0,
            filesReverted: false,
          },
          {
            turnIndex: 1,
            entryIndex: 10,
            preview: "Oldest request",
            timestamp: 1,
            fileCount: 0,
            additions: 0,
            deletions: 0,
            filesReverted: false,
          },
        ],
      },
    });

    expect(options[0]).toEqual(expect.objectContaining({
      label: "Message",
      detail: "Changes",
      disabled: true,
    }));
    expect(options[1]).toEqual(expect.objectContaining({
      label: "(Current)",
      value: "0:cancel",
    }));
    expect(options[2]).toEqual(expect.objectContaining({
      label: "Newest request",
      detail: "+17 -30 3 files",
    }));
    expect(options[3]).toEqual(expect.objectContaining({
      label: "Older request",
      detail: "1 file",
    }));
    expect(options[4]).toEqual(expect.objectContaining({
      label: "Oldest request",
      detail: "No code changes",
    }));

    const picker = createCommandPicker("/rewind", options);
    expect(picker.stack[0]?.selected).toBe(1);
    expect(acceptCommandPickerSelection(picker)).toEqual({
      kind: "submit",
      command: "/rewind 0:cancel",
    });
  });
});
