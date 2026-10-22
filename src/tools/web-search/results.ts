/** 搜索结果的值类型、文本/JSON 解析与展示格式化。 */
// ------------------------------------------------------------------
// 工具定义
// ------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  highlights: string[];
  publishedDate?: string;
  author?: string;
  score?: number;
}

const RESULT_MAX_EXCERPT_CHARS = 2_400;

const SOFT_TRUNCATE_LOOKAHEAD_CHARS = 200;

const MAX_VISIBLE_EXCERPTS = 3;

const TEXT_RESULT_FIELD_LABELS = [
  "Title",
  "URL",
  "Published",
  "Published Date",
  "Author",
  "Score",
  "Highlights",
  "Summary",
  "Text",
  "Content",
  "Snippet",
  "Favicon",
] as const;

const TEXT_RESULT_FIELD_SET = new Set<string>(TEXT_RESULT_FIELD_LABELS);

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cleanResultText(text: string): string {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed === "[...]" || trimmed === "---" ? "" : trimmed;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateResultText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return "…";

  const lookaheadEnd = Math.min(text.length, limit + SOFT_TRUNCATE_LOOKAHEAD_CHARS);
  for (let i = limit; i < lookaheadEnd; i++) {
    if (/\s/.test(text[i])) {
      return text.slice(0, i).trimEnd() + "…";
    }
  }

  for (let i = limit - 1; i > 0; i--) {
    if (/\s/.test(text[i])) {
      return text.slice(0, i).trimEnd() + "…";
    }
  }

  return text.slice(0, limit - 1).trimEnd() + "…";
}

function firstNonEmptyLine(text: string): string {
  return cleanResultText(text).split("\n").find((line) => line.trim()) ?? "";
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function normalizeResultTitle(title: string, url: string, highlights: string[]): string {
  if (title && title.toLowerCase() !== "n/a") return title;
  for (const highlight of highlights) {
    const line = firstNonEmptyLine(highlight);
    if (line) return line;
  }
  return url ? titleFromUrl(url) : "Untitled result";
}

function normalizeHighlights(highlights: string[]): { highlights: string[]; omittedCount: number } {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of highlights) {
    const cleaned = cleanResultText(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }

  const visible: string[] = [];
  let remaining = RESULT_MAX_EXCERPT_CHARS;
  const limit = Math.min(unique.length, MAX_VISIBLE_EXCERPTS);
  for (let i = 0; i < limit; i++) {
    if (remaining <= 0) break;
    const excerpt = unique[i];
    const next = truncateResultText(excerpt, remaining);
    visible.push(next);
    remaining -= next.length;
    if (next.endsWith("…")) break;
  }

  return {
    highlights: visible,
    omittedCount: Math.max(0, unique.length - visible.length),
  };
}

export function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return "No results found. Try rephrasing your search.";
  }
  const lines: string[] = [`Found ${results.length} results for "${query}":\n`];
  for (let i = 0; i < results.length; i++) {
    lines.push(`${i + 1}. ${results[i].title}`);
    if (results[i].url) {
      lines.push(`   URL: ${results[i].url}`);
    }
    if (results[i].publishedDate) {
      lines.push(`   Published: ${results[i].publishedDate}`);
    }
    if (results[i].author) {
      lines.push(`   Author: ${results[i].author}`);
    }
    if (typeof results[i].score === "number") {
      lines.push(`   Score: ${results[i].score}`);
    }
    const { highlights, omittedCount } = normalizeHighlights(results[i].highlights);
    if (highlights.length > 0) {
      lines.push("   Highlights:");
      for (let j = 0; j < highlights.length; j++) {
        if (j > 0) lines.push("");
        for (const line of highlights[j].split("\n")) {
          lines.push(line ? `   ${line}` : "");
        }
      }
    }
    if (omittedCount > 0) {
      lines.push(`   ... ${omittedCount} more highlight block${omittedCount === 1 ? "" : "s"} omitted`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function stringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "n/a") {
      return value.trim();
    }
  }
  return "";
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeSearchResultObject(obj: Record<string, unknown>): SearchResult | null {
  const url = stringField(obj, ["url", "URL", "link"]);
  const title = stringField(obj, ["title", "Title", "name", "Name"]);
  if (!title && !url) return null;

  const highlights: string[] = [];
  const excerptArray = obj["excerpts"] ?? obj["Excerpts"];
  if (Array.isArray(excerptArray)) {
    highlights.push(...excerptArray.filter((item): item is string => typeof item === "string"));
  }
  const shortText = stringField(obj, ["snippet", "Snippet", "description", "Description"]);
  if (shortText) highlights.push(shortText);
  const summary = stringField(obj, ["summary", "Summary"]);
  if (summary) highlights.push(summary);
  const highlightsValue = obj["highlights"] ?? obj["Highlights"];
  if (Array.isArray(highlightsValue)) {
    highlights.push(...highlightsValue.filter((h): h is string => typeof h === "string"));
  } else {
    const highlightText = stringField(obj, ["highlights", "Highlights"]);
    if (highlightText) highlights.push(highlightText);
  }
  const longText = stringField(obj, ["text", "Text", "content", "Content"]);
  if (longText) highlights.push(longText);

  return {
    title: normalizeResultTitle(title, url, highlights),
    url,
    highlights,
    publishedDate: stringField(obj, ["publishedDate", "published_date", "published", "page_age", "Published"]),
    author: stringField(obj, ["author", "authors", "Author"]),
    score: numberField(obj, ["score"]),
  };
}

function parseSearchResultsJson(text: string): SearchResult[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj["results"])) candidates.push(...obj["results"]);
      const web = (obj["results"] as Record<string, unknown> | undefined)?.["web"] ?? obj["web"];
      if (Array.isArray(web)) candidates.push(...web);
      const news = (obj["results"] as Record<string, unknown> | undefined)?.["news"] ?? obj["news"];
      if (Array.isArray(news)) candidates.push(...news);
    }
    return candidates
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(normalizeSearchResultObject)
      .filter((item): item is SearchResult => item !== null);
  } catch {
    return [];
  }
}

function textFieldLine(line: string): { label: string; value: string } | null {
  const match = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
  if (!match) return null;
  const label = match[1].trim();
  if (!TEXT_RESULT_FIELD_SET.has(label)) return null;
  return { label, value: match[2] ?? "" };
}

function firstLineField(block: TextResultBlock, labels: string[]): string {
  for (const label of labels) {
    const value = block.fields.get(label);
    if (!value) continue;
    const line = firstNonEmptyLine(value);
    if (line && line.toLowerCase() !== "n/a") return line;
  }
  return "";
}

function textField(block: TextResultBlock, labels: string[]): string {
  for (const label of labels) {
    const value = block.fields.get(label);
    if (!value) continue;
    const cleaned = cleanResultText(value);
    if (cleaned && cleaned.toLowerCase() !== "n/a") return cleaned;
  }
  return "";
}

interface TextResultBlock {
  fields: Map<string, string>;
}

function isResultStart(lines: string[], index: number): boolean {
  const field = textFieldLine(lines[index].trim());
  if (field?.label !== "Title") return false;
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i].trim();
    if (!next || next === "---") continue;
    return textFieldLine(next)?.label === "URL";
  }
  return false;
}

function splitTextResultBlocks(text: string): string[] {
  const lines = normalizeNewlines(text).split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isResultStart(lines, i)) starts.push(i);
  }
  if (starts.length === 0) return [];

  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    blocks.push(lines.slice(start, end).join("\n"));
  }
  return blocks;
}

function parseTextResultBlock(block: string): TextResultBlock {
  const lines = normalizeNewlines(block).split("\n");
  const fields = new Map<string, string>();
  let currentLabel: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentLabel) return;
    const value = currentLines.join("\n").trim();
    if (!value) return;
    const existing = fields.get(currentLabel);
    fields.set(currentLabel, existing ? `${existing}\n\n${value}` : value);
  };

  for (const line of lines) {
    const field = textFieldLine(line.trim());
    if (field) {
      flush();
      currentLabel = field.label;
      currentLines = [field.value];
      continue;
    }
    if (currentLabel) currentLines.push(line);
  }
  flush();

  return { fields };
}

export function parseSearchResultsText(text: string): SearchResult[] {
  const jsonResults = parseSearchResultsJson(text);
  if (jsonResults.length > 0) return jsonResults;

  const blocks = splitTextResultBlocks(text).map(parseTextResultBlock);
  if (blocks.length === 0) return [];

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const summary = textField(block, ["Summary"]);
    const highlights = textField(block, ["Highlights"]);
    const longText = textField(block, ["Text", "Content"]);
    const resultHighlights = [
      textField(block, ["Snippet"]),
      summary,
      highlights,
      longText,
    ].filter((value) => value);
    const scoreRaw = firstLineField(block, ["Score"]);
    const score = scoreRaw ? Number(scoreRaw) : undefined;
    const title = firstLineField(block, ["Title"]);
    const url = firstLineField(block, ["URL"]);

    results.push({
      title: normalizeResultTitle(title, url, resultHighlights),
      url,
      highlights: resultHighlights,
      publishedDate: firstLineField(block, ["Published", "Published Date"]) || undefined,
      author: firstLineField(block, ["Author"]) || undefined,
      score: Number.isFinite(score) ? score : undefined,
    });
  }

  return results;
}

// 鈹€鈹€ Backend detection (cached) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
