import { describe, expect, it } from "vitest";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  getCommandPickerVisibleRange,
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

  it("keeps inline mode while drilling from provider to model", () => {
    const picker = createCommandPicker("/model", [
      {
        label: "JuCode",
        value: "jucode",
        children: [{ label: "GPT 5", value: "jucode:gpt-5" }],
      },
    ], 5, undefined, false, true);

    expect(picker.inputArea).toBe(true);
    const drilled = acceptCommandPickerSelection(picker);
    expect(drilled?.kind).toBe("drill_down");
    if (drilled?.kind !== "drill_down") throw new Error("unreachable");
    expect(drilled.picker.inputArea).toBe(true);
    expect(acceptCommandPickerSelection(drilled.picker)).toEqual({
      kind: "submit",
      command: "/model jucode:gpt-5",
    });
  });

  it("scrolls long inline lists without changing the picker slot", () => {
    const picker = createCommandPicker("/model", Array.from({ length: 8 }, (_, index) => ({
      label: `Provider ${index + 1}`,
      value: `provider-${index + 1}`,
    })), 3, undefined, false, true);

    expect(getCommandPickerVisibleRange(picker)).toEqual({ start: 0, end: 3 });
    const moved = moveCommandPickerSelection(picker, 6);
    expect(moved.inputArea).toBe(true);
    expect(moved.stack[0]?.selected).toBe(6);
    expect(getCommandPickerVisibleRange(moved)).toEqual({ start: 4, end: 7 });
  });

  it("cancels a child level while preserving the inline picker state", () => {
    const picker = createCommandPicker("/model", [
      { label: "Provider", value: "provider", children: [{ label: "Model", value: "provider:model" }] },
    ], 3, undefined, false, true);
    const drilled = acceptCommandPickerSelection(picker);
    if (drilled?.kind !== "drill_down") throw new Error("unreachable");
    const parent = exitCommandPickerLevel(drilled.picker);
    expect(parent?.inputArea).toBe(true);
    expect(parent?.stack).toHaveLength(1);
  });

  it("returns a toggle result for a toggle picker", () => {
    const picker = createCommandPicker(
      "/skills",
      [{ label: "demo description enable", value: "demo" }],
      5,
      "Skills",
      false,
      true,
      "toggle",
    );
    expect(acceptCommandPickerSelection(picker)).toEqual({
      kind: "toggle",
      command: "/skills demo",
      value: "demo",
    });
  });
});
