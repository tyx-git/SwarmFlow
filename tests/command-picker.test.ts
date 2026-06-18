import { describe, expect, it } from "bun:test";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  moveCommandPickerSelection,
  setCommandPickerSelection,
} from "../src/ui/command-picker.js";

describe("command picker", () => {
  it("skips disabled heading rows for initial selection and submission", () => {
    const picker = createCommandPicker("/session", [
      { label: "Created  Active  Title", value: "", disabled: true },
      { label: "2 days ago  1 day ago  Fix login", value: "session-a" },
      { label: "5 days ago  5 days ago  Refactor picker", value: "session-b" },
    ]);

    expect(picker.stack[0]?.selected).toBe(1);
    expect(acceptCommandPickerSelection(picker)).toEqual({
      kind: "submit",
      command: "/session session-a",
    });

    const unchanged = setCommandPickerSelection(picker, 0);
    expect(unchanged.stack[0]?.selected).toBe(1);

    const moved = moveCommandPickerSelection(picker, -1);
    expect(moved.stack[0]?.selected).toBe(2);
  });

  it("custom-input options enter input mode once and submit on re-accept", () => {
    const picker = createCommandPicker("/summarize_hint", [
      { label: "On", value: "on" },
      {
        label: "Level 1 (50%)",
        value: "level1",
        customInput: true,
        inputLabel: "Level 1 trigger %:",
        inputPlaceholder: "integer 1-74",
      },
    ]);

    // First accept on the custom-input option → enter input mode and carry
    // the option's label/placeholder into picker state.
    const selected = setCommandPickerSelection(picker, 1);
    const entered = acceptCommandPickerSelection(selected);
    expect(entered).toMatchObject({ kind: "custom_input" });
    if (entered?.kind !== "custom_input") throw new Error("unreachable");
    expect(entered.picker.customInputMode).toBe(true);
    expect(entered.picker.customInputLabel).toBe("Level 1 trigger %:");
    expect(entered.picker.customInputPlaceholder).toBe("integer 1-74");

    // Accepting again while IN the mode must submit (with the typed note),
    // not re-enter the mode and clear the field.
    const typed = { ...entered.picker, note: "40" };
    expect(acceptCommandPickerSelection(typed)).toEqual({
      kind: "submit",
      command: "/summarize_hint level1",
      note: "40",
    });
  });
});
