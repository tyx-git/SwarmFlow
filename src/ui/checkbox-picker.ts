export interface CheckboxPickerItem {
  label: string;
  value: string;
  checked: boolean;
}

export interface CheckboxPickerState {
  title: string;
  items: CheckboxPickerItem[];
  selected: number;
  visibleStart: number;
  maxVisible: number;
}

export type CheckboxPickerResult =
  | { kind: "toggle"; picker: CheckboxPickerState }
  | { kind: "submit"; items: CheckboxPickerItem[] };

function clampSelection(selected: number, count: number): number {
  if (count === 0) return 0;
  if (selected < 0) return 0;
  if (selected >= count) return count - 1;
  return selected;
}

function clampVisibleStart(
  start: number,
  count: number,
  maxVisible: number,
): number {
  if (count <= maxVisible) return 0;
  return Math.max(0, Math.min(start, count - maxVisible));
}

export function createCheckboxPicker(
  title: string,
  items: CheckboxPickerItem[],
  maxVisible = items.length,
): CheckboxPickerState {
  return {
    title,
    items: items.map((item) => ({ ...item })),
    selected: 0,
    visibleStart: 0,
    maxVisible,
  };
}

export function isCheckboxPickerActive(
  picker: CheckboxPickerState | null | undefined,
): picker is CheckboxPickerState {
  return Boolean(picker && picker.items.length > 0);
}

export function getCheckboxPickerVisibleRange(
  picker: CheckboxPickerState,
): { start: number; end: number } {
  const count = picker.items.length;
  const maxVisible = Math.max(1, picker.maxVisible);
  if (count <= maxVisible) {
    return { start: 0, end: count };
  }

  let start = clampVisibleStart(picker.visibleStart, count, maxVisible);
  if (picker.selected < start) {
    start = picker.selected;
  } else if (picker.selected >= start + maxVisible) {
    start = picker.selected - maxVisible + 1;
  }
  start = clampVisibleStart(start, count, maxVisible);
  return { start, end: start + maxVisible };
}

export function moveCheckboxSelection(
  picker: CheckboxPickerState,
  delta: number,
): CheckboxPickerState {
  const count = picker.items.length;
  if (count === 0 || delta === 0) return picker;

  const maxVisible = Math.max(1, picker.maxVisible);
  let nextSelected = picker.selected;
  let nextVisibleStart = clampVisibleStart(picker.visibleStart, count, maxVisible);
  const direction = delta > 0 ? 1 : -1;

  for (let step = 0; step < Math.abs(delta); step += 1) {
    nextSelected = (nextSelected + direction + count) % count;

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
    selected: nextSelected,
    visibleStart: nextVisibleStart,
  };
}

export function setCheckboxPickerSelection(
  picker: CheckboxPickerState,
  index: number,
): CheckboxPickerState {
  const count = picker.items.length;
  if (count === 0) return picker;

  const selected = clampSelection(index, count);
  const maxVisible = Math.max(1, picker.maxVisible);
  let visibleStart = clampVisibleStart(picker.visibleStart, count, maxVisible);
  if (selected < visibleStart) {
    visibleStart = selected;
  } else if (selected >= visibleStart + maxVisible) {
    visibleStart = selected - maxVisible + 1;
  }
  visibleStart = clampVisibleStart(visibleStart, count, maxVisible);

  return { ...picker, selected, visibleStart };
}

export function toggleCheckboxItem(
  picker: CheckboxPickerState,
): CheckboxPickerState {
  const index = clampSelection(picker.selected, picker.items.length);
  const items = picker.items.map((item, itemIndex) =>
    itemIndex === index ? { ...item, checked: !item.checked } : item,
  );
  return { ...picker, items };
}

export function submitCheckboxPicker(
  picker: CheckboxPickerState,
): CheckboxPickerResult {
  return { kind: "submit", items: [...picker.items] };
}
