/** Shared presentation contract for selectors rendered by the TUI. */
export interface InputAreaPickerConfig {
  /** Render the selector in the composer slot instead of the footer overlay. */
  inputArea?: boolean;
  /** Optional heading shown above the selector rows. */
  title?: string;
}

/** Registration metadata shared by slash-command picker implementations. */
export interface CommandPickerPresentation extends InputAreaPickerConfig {
  /** Single-level/hierarchical picker or multi-select checkbox picker. */
  mode?: "single" | "checkbox";
  /** Enable the optional note field on a command picker. */
  allowNote?: boolean;
}
