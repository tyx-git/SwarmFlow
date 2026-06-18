/**
 * Minimal JSONC (JSON with Comments) parser.
 *
 * Strips single-line (`//`) and multi-line (`/* ... *鈥?`) comments
 * from the input string, then delegates to `JSON.parse`.
 *
 * Does NOT strip comments inside JSON string values 鈥?the regex
 * handles quoted strings as opaque tokens so that `"http://example.com"`
 * is preserved intact.
 */

/**
 * Strip comments from a JSONC string and return plain JSON.
 */
export function stripJsoncComments(text: string): string {
  // Match (in order):
  //   1. double-quoted strings (preserve as-is)
  //   2. single-line comments  (// ... EOL)
  //   3. multi-line comments   (/* ... */)
  return text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => {
      if (match.startsWith('"')) return match; // preserve string literals
      // Replace comment with equivalent whitespace to keep line numbers stable
      return match.replace(/[^\n]/g, " ");
    },
  );
}

/**
 * Parse a JSONC string. Returns `undefined` on failure instead of throwing.
 */
export function parseJsonc<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(stripJsoncComments(text)) as T;
  } catch {
    return undefined;
  }
}
