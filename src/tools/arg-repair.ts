/**
 * Tool-input repair 鈥?forgiving coercions for the small, finite set of
 * malformed-but-recoverable tool arguments that open models (DeepSeek, GLM,
 * Qwen, Kimi, 鈥? routinely emit.
 *
 * Design principle: VALIDATE-THEN-REPAIR, never preprocess. Callers parse the
 * input as-is first; only ON a type mismatch do they consult these repairs at
 * the exact failing argument. Valid inputs are never touched 鈥?this is what
 * keeps a `write_file` `content` that merely *looks* like JSON from being
 * silently rewritten. The validator localizes the bug; we only spend repair
 * budget where the schema actually disagreed.
 *
 * The catalogue is deliberately tiny and closed. Across the open models we
 * serve, the same shape mistakes repeat almost exactly:
 *   1. `null` for an optional field instead of omitting it
 *        鈫?already absorbed by callers' optional-arg helpers (`v == null`).
 *   2. `'["a","b"]'` emitted as a JSON *string* instead of an array.
 *   3. a value wrapped in an object `{}` placeholder where an array was wanted.
 *   4. a bare string `"foo"` where an array `["foo"]` was wanted.
 *
 * ORDER MATTERS: the JSON-string-array parse (2) must run before the
 * bare-string wrap (4), otherwise `'["a","b"]'` becomes `['["a","b"]']`.
 *
 * Separately, a path-specific repair unwraps the degenerate markdown
 * auto-link a model leaks from its chat distribution into a path field
 * (`"[notes.md](http://notes.md)"`), where link text equals the URL minus its
 * protocol. Genuine links (`[click](https://example.com)`) pass through.
 */

export type ArgRepairKind =
  | "json_string_array"
  | "object_placeholder_unwrap"
  | "bare_string_to_array"
  | "autolink_path_unwrap";

/** Optional telemetry sink. Lets the harness watch per-(model,tool) repair
 *  rates without coupling this pure module to Session/logging. No-op default. */
let repairSink: ((info: { tool: string; key: string; kind: ArgRepairKind }) => void) | null = null;

export function setArgRepairSink(
  sink: ((info: { tool: string; key: string; kind: ArgRepairKind }) => void) | null,
): void {
  repairSink = sink;
}

function reportRepair(tool: string, key: string, kind: ArgRepairKind): void {
  try {
    repairSink?.({ tool, key, kind });
  } catch {
    /* telemetry must never break a tool call */
  }
}

/**
 * Attempt to coerce a non-array `value` into a string[] using repairs 2鈥?.
 * Returns the repaired array (and which repair fired) or null if unrepairable.
 * Pure 鈥?does not report telemetry; callers report on accept so the failing
 * path is known.
 */
export function repairToStringArray(
  value: unknown,
): { value: string[]; kind: ArgRepairKind } | null {
  // (2) stringified JSON array 鈥?MUST precede the bare-string wrap below.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
          return { value: parsed as string[], kind: "json_string_array" };
        }
      } catch {
        /* not valid JSON 鈥?fall through to bare-string wrap */
      }
    }
    // (4) bare string 鈫?single-element array.
    return { value: [value], kind: "bare_string_to_array" };
  }

  // (3) object placeholder. An empty object {} stands for an empty array; an
  // object whose values are all strings is unwrapped to those values via
  // Object.values (insertion order). NOTE: this is only safe for string[]
  // targets whose element keys carry NO semantics (order is the only meaning,
  // e.g. kill_shell/kill_agent `ids`). Do not route a keyed-semantic field
  // through repairToStringArray 鈥?`{"first":..,"second":..}` would be flattened
  // to an unordered-by-meaning value list.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length === 0) {
      return { value: [], kind: "object_placeholder_unwrap" };
    }
    if (vals.every((x) => typeof x === "string")) {
      return { value: vals as string[], kind: "object_placeholder_unwrap" };
    }
  }

  return null;
}

/** Public entry: repair + report. Returns string[] or null. */
export function coerceStringArray(
  tool: string,
  key: string,
  value: unknown,
): string[] | null {
  const repaired = repairToStringArray(value);
  if (!repaired) return null;
  reportRepair(tool, key, repaired.kind);
  return repaired.value;
}

const AUTOLINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;

/**
 * Unwrap ONLY the degenerate markdown auto-link a model leaks into a path:
 * link text equals the URL with any `http(s)://` stripped. Genuine links are
 * left untouched. Returns the unwrapped path (or the original string).
 */
export function repairAutolinkPath(value: string): { value: string; repaired: boolean } {
  const m = value.trim().match(AUTOLINK_RE);
  if (m) {
    const text = m[1];
    const url = m[2];
    const urlNoProto = url.replace(/^https?:\/\//, "");
    if (text === url || text === urlNoProto) {
      return { value: text, repaired: true };
    }
  }
  return { value, repaired: false };
}

/** Public entry: unwrap autolink path + report. */
export function coercePathString(tool: string, key: string, value: string): string {
  const { value: unwrapped, repaired } = repairAutolinkPath(value);
  if (repaired) reportRepair(tool, key, "autolink_path_unwrap");
  return unwrapped;
}
