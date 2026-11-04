/**
 * Ported from OpenAI Codex `codex-rs/apply-patch` (Apache-2.0).
 * Upstream: external/codex/codex-rs/apply-patch/src/seek_sequence.rs
 * Modified for SwarmFlow: TypeScript port.
 */

function normalisePunctuation(value: string): string {
  let result = "";
  for (const char of value.trim()) {
    switch (char) {
      case "\u2010":
      case "\u2011":
      case "\u2012":
      case "\u2013":
      case "\u2014":
      case "\u2015":
      case "\u2212":
        result += "-";
        break;
      case "\u2018":
      case "\u2019":
      case "\u201A":
      case "\u201B":
        result += "'";
        break;
      case "\u201C":
      case "\u201D":
      case "\u201E":
      case "\u201F":
        result += '"';
        break;
      case "\u00A0":
      case "\u2002":
      case "\u2003":
      case "\u2004":
      case "\u2005":
      case "\u2006":
      case "\u2007":
      case "\u2008":
      case "\u2009":
      case "\u200A":
      case "\u202F":
      case "\u205F":
      case "\u3000":
        result += " ";
        break;
      default:
        result += char;
        break;
    }
  }
  return result;
}

/**
 * 从 `start` 起寻找 `pattern`，按 exact → rstrip → trim → Unicode 标点归一
 * 四段阶梯降级；返回首个命中下标，找不到返回 null。
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart = eof
    ? Math.max(lines.length - pattern.length, start)
    : start;
  const lastStart = lines.length - pattern.length;

  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (lines[i + p] !== pattern[p]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (lines[i + p]!.trimEnd() !== pattern[p]!.trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (lines[i + p]!.trim() !== pattern[p]!.trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (
        normalisePunctuation(lines[i + p]!) !== normalisePunctuation(pattern[p]!)
      ) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return null;
}
