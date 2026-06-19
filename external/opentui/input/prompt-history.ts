import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getSwarmflowHomeDir } from "../../../src/lib/home-path.js";

const MAX_ENTRIES = 200;
const STATE_SUBDIR = "state";
const FILE_NAME = "prompt-history.jsonl";

interface PromptHistoryEntry {
  input: string;
}

interface PromptHistoryState {
  loaded: boolean;
  homeDirOverride: string | null;
  history: PromptHistoryEntry[];
  /** 0 = draft slot (showing liveDraft); -1 = newest; -2 = second newest; ... */
  index: number;
  /** Original draft saved on first entry into history (index 0 → -1). */
  liveDraft: string;
}

export function getPromptHistoryNavigationDirection(input: {
  keyName: string;
  cursorOffset: number;
  textDisplayWidth: number;
  selectedChildId?: string | null;
}): 1 | -1 | undefined {
  if (input.selectedChildId) return undefined;
  if (input.keyName === "up" && input.cursorOffset === 0) return -1;
  if (input.keyName === "down" && input.cursorOffset === input.textDisplayWidth) return 1;
  return undefined;
}

const state: PromptHistoryState = {
  loaded: false,
  homeDirOverride: null,
  history: [],
  index: 0,
  liveDraft: "",
};

function resolveFilePath(): string {
  const home = state.homeDirOverride ?? getSwarmflowHomeDir();
  return join(home, STATE_SUBDIR, FILE_NAME);
}

function ensureLoaded(): void {
  if (state.loaded) return;
  state.loaded = true;
  const path = resolveFilePath();
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const parsed: PromptHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.input === "string") parsed.push({ input: obj.input });
    } catch {
      // Drop malformed line; self-heal below.
    }
  }
  const kept = parsed.slice(-MAX_ENTRIES);
  state.history = kept;

  const reserialized = kept.length === 0 ? "" : kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
  if (reserialized !== raw) {
    try {
      writeFileSync(path, reserialized);
    } catch {
      // best-effort — next start will retry
    }
  }
}

/**
 * Test-only: re-init module state. Pass a temp dir to redirect the JSONL file.
 * Pass `null` to fall back to the real Fermi home.
 */
export function __resetPromptHistoryForTesting(homeDir: string | null = null): void {
  state.loaded = false;
  state.homeDirOverride = homeDir;
  state.history = [];
  state.index = 0;
  state.liveDraft = "";
}

/**
 * Append a submitted prompt to history.
 * - Skips empty input.
 * - Skips slash commands (anything starting with "/") — they're invocations,
 *   not prompts the user wants to recall and re-edit.
 * - Skips if identical to the most recent entry (adjacent dedup).
 * - Trims to MAX_ENTRIES.
 * - Resets navigation state (index = 0, liveDraft = "") on every call,
 *   including the skip paths.
 * - Persists to disk via append, or full rewrite when trimmed.
 * Errors are swallowed (best-effort).
 */
export function appendPromptHistory(input: string): void {
  ensureLoaded();
  if (!input || input.startsWith("/")) {
    state.index = 0;
    state.liveDraft = "";
    return;
  }
  const last = state.history[state.history.length - 1];
  if (last && last.input === input) {
    state.index = 0;
    state.liveDraft = "";
    return;
  }
  const entry: PromptHistoryEntry = { input };
  state.history.push(entry);
  let didTrim = false;
  if (state.history.length > MAX_ENTRIES) {
    state.history = state.history.slice(-MAX_ENTRIES);
    didTrim = true;
  }
  state.index = 0;
  state.liveDraft = "";

  const path = resolveFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (didTrim) {
      const content = state.history.map((e) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(path, content);
    } else {
      appendFileSync(path, JSON.stringify(entry) + "\n");
    }
  } catch {
    // best-effort
  }
}

/**
 * Navigate prompt history (方案 2 semantics):
 * - direction = -1 walks toward older entries; +1 walks toward the draft slot.
 * - Always navigates if there is somewhere to go; never refuses based on input edits.
 * - On entering history (index 0 → -1), captures `currentInput` as liveDraft.
 * - On returning to index 0, returns the saved liveDraft.
 * - Returns `undefined` only when history is empty or navigation would go out of bounds;
 *   the caller should fall through to default behavior in that case.
 */
export function navigatePromptHistory(
  direction: 1 | -1,
  currentInput: string,
): string | undefined {
  ensureLoaded();
  if (state.history.length === 0) return undefined;

  const next = state.index + direction;
  if (next > 0) return undefined;
  if (-next > state.history.length) return undefined;

  if (state.index === 0 && direction === -1) {
    state.liveDraft = currentInput;
  }
  state.index = next;

  if (state.index === 0) return state.liveDraft;
  return state.history.at(state.index)?.input ?? undefined;
}
