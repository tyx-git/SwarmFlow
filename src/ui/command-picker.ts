import type { CommandOption } from "../commands/commands.js";

export interface CommandPickerLevel {
  label: string;
  options: CommandOption[];
  selected: number;
  visibleStart: number;
}

export interface CommandPickerState {
  commandName: string;
  title?: string;
  maxVisible: number;
  stack: CommandPickerLevel[];
  note: string;
  noteEditing: boolean;
  /** When true, Tab opens an inline note input for attaching instructions. */
  allowNote: boolean;
  /** When true, the user is typing into a custom-input option's inline text field. */
  customInputMode: boolean;
  /** Label above the custom input field (from the triggering option's inputLabel). */
  customInputLabel?: string;
  /** Placeholder inside the custom input field (from the triggering option's inputPlaceholder). */
  customInputPlaceholder?: string;
}

export type CommandPickerAcceptResult =
  | { kind: "drill_down"; picker: CommandPickerState }
  | { kind: "custom_input"; picker: CommandPickerState }
  | { kind: "submit"; command: string; note?: string };

export interface CommandPickerResult {
  value: string;
  note?: string;
}

function clampSelection(selected: number, options: CommandOption[]): number {
  if (options.length === 0) return 0;
  if (selected < 0) return 0;
  if (selected >= options.length) return options.length - 1;
  return selected;
}

function isOptionSelectable(option: CommandOption | undefined): boolean {
  return Boolean(option && !option.disabled);
}

function firstSelectableIndex(options: CommandOption[]): number {
  const index = options.findIndex((option) => isOptionSelectable(option));
  return index >= 0 ? index : 0;
}

function clampVisibleStart(
  start: number,
  optionCount: number,
  maxVisible: number,
): number {
  if (optionCount <= maxVisible) return 0;
  return Math.max(0, Math.min(start, optionCount - maxVisible));
}

export function createCommandPicker(
  commandName: string,
  options: CommandOption[],
  maxVisible = options.length,
  title?: string,
  allowNote = false,
): CommandPickerState {
  const selected = firstSelectableIndex(options);
  return {
    commandName,
    title,
    maxVisible,
    stack: [{ label: commandName, options, selected, visibleStart: 0 }],
    note: "",
    noteEditing: false,
    allowNote,
    customInputMode: false,
  };
}

export function isCommandPickerActive(
  picker: CommandPickerState | null | undefined,
): picker is CommandPickerState {
  return Boolean(picker && picker.stack.length > 0);
}

export function getCommandPickerLevel(picker: CommandPickerState): CommandPickerLevel {
  return picker.stack[picker.stack.length - 1]!;
}

export function getCommandPickerPath(picker: CommandPickerState): string[] {
  return picker.stack.slice(1).map((level) => level.label);
}

export function getCommandPickerVisibleRange(
  picker: CommandPickerState,
): { start: number; end: number } {
  const level = getCommandPickerLevel(picker);
  const maxVisible = Math.max(1, picker.maxVisible);
  let start = clampVisibleStart(level.visibleStart, level.options.length, maxVisible);
  if (level.options.length <= maxVisible) {
    return { start: 0, end: level.options.length };
  }

  if (level.selected < start) {
    start = level.selected;
  } else if (level.selected >= start + maxVisible) {
    start = level.selected - maxVisible + 1;
  }

  start = clampVisibleStart(start, level.options.length, maxVisible);
  return { start, end: start + maxVisible };
}

export function moveCommandPickerSelection(
  picker: CommandPickerState,
  delta: number,
): CommandPickerState {
  const level = getCommandPickerLevel(picker);
  const count = level.options.length;
  if (count === 0 || delta === 0) return picker;

  const maxVisible = Math.max(1, picker.maxVisible);
  let nextSelected = level.selected;
  let nextVisibleStart = clampVisibleStart(level.visibleStart, count, maxVisible);
  const direction = delta > 0 ? 1 : -1;

  for (let step = 0; step < Math.abs(delta); step += 1) {
    let candidate = nextSelected;
    for (let guard = 0; guard < count; guard += 1) {
      candidate = (candidate + direction + count) % count;
      if (isOptionSelectable(level.options[candidate])) break;
    }
    nextSelected = candidate;

    if (count <= maxVisible) {
      nextVisibleStart = 0;
      continue;
    }
    if (nextSelected < nextVisibleStart) {
      nextVisibleStart = nextSelected;
    } else if (nextSelected >= nextVisibleStart + maxVisible) {
      nextVisibleStart = nextSelected - maxVisible + 1;
    }
    nextVisibleStart = clampVisibleStart(nextVisibleStart, count, maxVisible);
  }

  return {
    ...picker,
    stack: [
      ...picker.stack.slice(0, -1),
      { ...level, selected: nextSelected, visibleStart: nextVisibleStart },
    ],
  };
}

export function setCommandPickerSelection(
  picker: CommandPickerState,
  index: number,
): CommandPickerState {
  const level = getCommandPickerLevel(picker);
  const count = level.options.length;
  if (count === 0) return picker;

  const selected = clampSelection(index, level.options);
  if (!isOptionSelectable(level.options[selected])) return picker;
  const maxVisible = Math.max(1, picker.maxVisible);
  let visibleStart = clampVisibleStart(level.visibleStart, count, maxVisible);
  if (selected < visibleStart) {
    visibleStart = selected;
  } else if (selected >= visibleStart + maxVisible) {
    visibleStart = selected - maxVisible + 1;
  }
  visibleStart = clampVisibleStart(visibleStart, count, maxVisible);

  return {
    ...picker,
    stack: [
      ...picker.stack.slice(0, -1),
      { ...level, selected, visibleStart },
    ],
  };
}

export function isCommandPickerCustomInputOption(picker: CommandPickerState): boolean {
  const level = getCommandPickerLevel(picker);
  const option = level.options[clampSelection(level.selected, level.options)];
  return Boolean(option?.customInput);
}

export function exitCommandPickerCustomInput(picker: CommandPickerState): CommandPickerState {
  return { ...picker, customInputMode: false, customInputLabel: undefined, customInputPlaceholder: undefined };
}

export function exitCommandPickerLevel(picker: CommandPickerState): CommandPickerState | null {
  if (picker.stack.length <= 1) return null;
  return {
    ...picker,
    stack: picker.stack.slice(0, -1),
  };
}

export function toggleCommandPickerNoteEditing(
  picker: CommandPickerState,
): CommandPickerState {
  if (!picker.allowNote) return picker;
  return { ...picker, noteEditing: !picker.noteEditing };
}

export function setCommandPickerNote(
  picker: CommandPickerState,
  note: string,
): CommandPickerState {
  return { ...picker, note };
}

export function acceptCommandPickerSelection(
  picker: CommandPickerState,
): CommandPickerAcceptResult | null {
  const level = getCommandPickerLevel(picker);
  const option = level.options[clampSelection(level.selected, level.options)];
  if (!option) return null;
  if (!isOptionSelectable(option)) return null;

  if (option.children && option.children.length > 0) {
    return {
      kind: "drill_down",
      picker: {
        ...picker,
        stack: [
          ...picker.stack,
          {
            label: option.label,
            options: option.children,
            selected: firstSelectableIndex(option.children),
            visibleStart: 0,
          },
        ],
      },
    };
  }

  // Enter custom-input mode only when not already in it. While IN the mode,
  // an accept falls through to submit (note carries the typed text) 鈥?  // otherwise re-accepting would re-enter the mode and clear the field.
  if (option.customInput && !picker.customInputMode) {
    return {
      kind: "custom_input",
      picker: {
        ...picker,
        customInputMode: true,
        customInputLabel: option.inputLabel,
        customInputPlaceholder: option.inputPlaceholder,
      },
    };
  }

  const trimmedNote = picker.note.trim();
  return {
    kind: "submit",
    command: `${picker.commandName} ${option.value}`.trim(),
    note: trimmedNote || undefined,
  };
}
