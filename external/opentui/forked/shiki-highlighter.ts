/**
 * Shiki-based syntax highlighter — optional replacement for highlight.js.
 *
 * Provides VS Code–quality TextMate grammar highlighting with vivid theme colors.
 * Uses async initialization (grammar loading) but fully synchronous tokenization
 * after init.
 *
 * Usage:
 *   await initShikiHighlighter();           // call once at startup
 *   const chunks = shikiHighlightToChunks(code, "typescript");  // sync
 *
 * When not initialized (or init failed), all functions return null so the
 * caller can fall back to highlight.js.
 */

import { RGBA, type TextChunk } from "@opentui/core";
import type { ThemeMode } from "../display/theme/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Shiki theme names by mode. Catppuccin family — same author/family across modes. */
export const SHIKI_THEME_DARK = "catppuccin-mocha";
export const SHIKI_THEME_LIGHT = "catppuccin-latte";

/** Currently active shiki theme. Mutated by setShikiTheme(). Defaults to dark. */
let currentShikiTheme: string = SHIKI_THEME_DARK;

/** Switch the shiki theme to use for subsequent highlight calls. */
export function setShikiTheme(mode: ThemeMode): void {
  const next = mode === "light" ? SHIKI_THEME_LIGHT : SHIKI_THEME_DARK;
  if (next !== currentShikiTheme) {
    currentShikiTheme = next;
    // Keys embed the theme so stale entries are never returned; clear anyway
    // to bound memory across switches.
    highlightCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Per-line highlight cache (LRU)
// ---------------------------------------------------------------------------

/**
 * Tokenization is the dominant cost in syntax highlighting, and callers
 * (file-modify body, markdown code blocks) re-highlight the *same* line text
 * repeatedly — every streaming rebuild re-runs the whole visible file through
 * `codeToTokens`, even though only the appended tail actually changed. This
 * LRU memoizes `(theme, lang, code) -> raw tokens` so stable lines become
 * cache hits and only genuinely-new text is tokenized.
 *
 * The cache stores *raw* token data (`{ text, color? }`, color as a hex
 * string) — NOT live `TextChunk`/`RGBA` objects. Every access rebuilds fresh
 * chunks with fresh `RGBA` instances (`chunksFromRawTokens`), so a consumer
 * can never mutate state shared with the cache or with another call. This
 * preserves the pre-cache contract (each call produced brand-new chunks); the
 * only thing a hit skips is the expensive `codeToTokens`.
 */
interface RawToken {
  text: string;
  color?: string;
}

const HIGHLIGHT_CACHE_MAX = 4000;
const highlightCache = new Map<string, RawToken[]>();

function cacheGet(key: string): RawToken[] | undefined {
  const hit = highlightCache.get(key);
  if (hit === undefined) return undefined;
  // Refresh recency (Map preserves insertion order → re-insert moves to tail).
  highlightCache.delete(key);
  highlightCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: RawToken[]): void {
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    // Evict least-recently-used (first inserted).
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, value);
}

/** Rebuild fresh `TextChunk[]` (fresh RGBA objects) from cached raw tokens. */
function chunksFromRawTokens(tokens: RawToken[]): TextChunk[] {
  return tokens.map((t) => ({
    __isChunk: true,
    text: t.text,
    fg: t.color ? RGBA.fromHex(t.color) : undefined,
  }));
}

/**
 * Languages to pre-load at init.  Kept intentionally small to minimize
 * startup memory; everything else loads on-demand via `ensureLanguage()`
 * the first time a code block with that language is rendered.  Languages
 * not in this list, and not yet loaded, fall through to highlight.js
 * (see patch-opentui-markdown.ts) until the async load completes.
 */
const PRELOAD_LANGS = [
  "typescript", "tsx", "javascript", "jsx",
  "python", "bash",
  "json", "markdown", "diff",
];

// ---------------------------------------------------------------------------
// Language alias map (highlight.js name → Shiki name)
// ---------------------------------------------------------------------------

const LANG_ALIAS: Record<string, string> = {
  "objectivec": "objective-c",
  "dos": "batch",
  "delphi": "pascal",
  "vbnet": "vb",
};

function resolveLang(lang: string): string {
  return LANG_ALIAS[lang] ?? lang;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let highlighter: ShikiHighlighter | null = null;
let initPromise: Promise<void> | null = null;

/** Minimal interface — we only use codeToTokens + loadLanguage. */
interface ShikiHighlighter {
  codeToTokens: (code: string, options: {
    lang: string;
    theme: string;
  }) => {
    tokens: Array<Array<{ content: string; color?: string; fontStyle?: number }>>;
    fg?: string;
    bg?: string;
  };
  getLoadedLanguages: () => string[];
  loadLanguage: (...langs: unknown[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the Shiki highlighter singleton.  Safe to call multiple times —
 * subsequent calls return the same promise.
 */
export async function initShikiHighlighter(): Promise<void> {
  if (highlighter) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const shiki = await import("shiki");
      const h = await shiki.createHighlighter({
        themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
        langs: PRELOAD_LANGS,
      });
      highlighter = h as unknown as ShikiHighlighter;
    } catch (err) {
      // Swallow — caller will fall back to hljs.
      highlighter = null;
    }
  })();

  return initPromise;
}

/** Whether the Shiki highlighter is ready for synchronous use. */
export function isShikiReady(): boolean {
  return highlighter !== null;
}

/**
 * Ensure a language grammar is loaded.  Returns `true` if the language is
 * available after the call (already loaded or successfully loaded now).
 */
async function ensureLanguage(lang: string): Promise<boolean> {
  if (!highlighter) return false;
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return true;
  try {
    await highlighter.loadLanguage(lang as any);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous tokenization.  Returns `TextChunk[]` with fg colors from the
 * Shiki theme, or `null` if Shiki is not initialized / language unavailable.
 *
 * Signature mirrors `highlightToChunks()` from patch-opentui-markdown.ts so
 * it can be used as a drop-in replacement.
 */
export function shikiHighlightToChunks(
  code: string,
  lang: string | undefined,
): TextChunk[] | null {
  if (!highlighter || !lang) return null;

  const resolved = resolveLang(lang);

  // Only attempt languages we've already loaded (sync path — no await).
  const loaded = highlighter.getLoadedLanguages();
  if (!loaded.includes(resolved)) {
    // Fire-and-forget: load for next time.
    ensureLanguage(resolved);
    return null;
  }

  const cacheKey = `${currentShikiTheme}\x00${resolved}\x00${code}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return cached.length > 0 ? chunksFromRawTokens(cached) : null;
  }

  try {
    const result = highlighter.codeToTokens(code, {
      lang: resolved,
      theme: currentShikiTheme,
    });

    // result.tokens is line-based — each outer entry is a line of tokens
    // with line breaks stripped by Shiki.  Flatten into a single raw-token
    // array, inserting a "\n" token between lines to preserve line breaks.
    const tokens: RawToken[] = [];
    for (let i = 0; i < result.tokens.length; i++) {
      const line = result.tokens[i];
      for (const token of line) {
        tokens.push({ text: token.content, color: token.color });
      }
      if (i < result.tokens.length - 1) {
        tokens.push({ text: "\n" });
      }
    }
    // Cache even empty results so repeated misses on the same text are cheap.
    cacheSet(cacheKey, tokens);
    return tokens.length > 0 ? chunksFromRawTokens(tokens) : null;
  } catch {
    return null;
  }
}
