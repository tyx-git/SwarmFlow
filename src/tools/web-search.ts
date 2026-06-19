/**
 * Web search 工具定义、客户端执行器和直通车处理器。
 *
 * 具有原生搜索功能的提供商（Anthropic、OpenAI、GLM、Kimi）
 * 在其 `convertTools()` 中用特定于提供商的格式替换此 ToolDef。
 * 没有原生搜索的提供商将其保留为常规函数工具；
 * 客户端执行器通过优先级链处理：
 *
 *   1. API key 后端（SERPER →TAVILY →EXA →BRAVE）
 *   2. Exa 免费 MCP 端点（零配置）
 *   3. Parallel Web Search MCP（零配置，自有索引）
 *   4. DuckDuckGo 轻量抓取（零配置后备）
 */

import type { ToolDef } from "../providers/base.js";

// ------------------------------------------------------------------
// 工具定义
// ------------------------------------------------------------------

export const WEB_SEARCH: ToolDef = {
  name: "web_search",
  description:
    "Search the web for current information. " +
    "Returns titles, URLs and highlights for the top results.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
      num_results: {
        type: "integer",
        description: "Number of results to return (default: 5)",
        default: 5,
      },
    },
    required: ["query"],
  },
  summaryTemplate: "{agent} is searching the web for '{query}'",
  tuiPolicy: { partialReveal: { completeArgs: ["query"] } },
};

// ------------------------------------------------------------------
// Kimi $web_search 的直通车
// ------------------------------------------------------------------

export function toolBuiltinWebSearchPassthrough(
  kwargs: Record<string, unknown>,
): string {
  return JSON.stringify(kwargs);
}

// ------------------------------------------------------------------
// 客户端 Web 搜索执行器
// ------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  highlights: string[];
  publishedDate?: string;
  author?: string;
  score?: number;
}

const SEARCH_TIMEOUT_MS = 25_000;
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
  if (limit <= 1) return "—;

  const lookaheadEnd = Math.min(text.length, limit + SOFT_TRUNCATE_LOOKAHEAD_CHARS);
  for (let i = limit; i < lookaheadEnd; i++) {
    if (/\s/.test(text[i])) {
      return text.slice(0, i).trimEnd() + "—;
    }
  }

  for (let i = limit - 1; i > 0; i--) {
    if (/\s/.test(text[i])) {
      return text.slice(0, i).trimEnd() + "—;
    }
  }

  return text.slice(0, limit - 1).trimEnd() + "—;
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

function normalizeResultTitle(title: string, url: string, highlights: string[]): string {
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
    if (next.endsWith("—)) break;
  }

  return {
    highlights: visible,
    omittedCount: Math.max(0, unique.length - visible.length),
  };
}

function formatResults(results: SearchResult[], query: string): string {
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

function parseSearchResultsText(text: string): SearchResult[] {
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

type BackendKind = "serper" | "tavily" | "exa_api" | "brave" | "exa_free" | "parallel_free" | "ddg";

interface ApiBackend {
  kind: "serper" | "tavily" | "exa_api" | "brave";
  key: string;
}

let _resolvedBackend: BackendKind | null = null;
let _resolvedApiKey: string | null = null;

function resolveBackend(): { kind: BackendKind; key?: string } {
  if (_resolvedBackend !== null) {
    return _resolvedApiKey
      ? { kind: _resolvedBackend, key: _resolvedApiKey }
      : { kind: _resolvedBackend };
  }

  const checks: Array<{ env: string; kind: ApiBackend["kind"] }> = [
    { env: "SERPER_API_KEY", kind: "serper" },
    { env: "TAVILY_API_KEY", kind: "tavily" },
    { env: "EXA_API_KEY", kind: "exa_api" },
    { env: "BRAVE_SEARCH_API_KEY", kind: "brave" },
  ];

  for (const { env, kind } of checks) {
    const key = process.env[env];
    if (key && key.trim()) {
      _resolvedBackend = kind;
      _resolvedApiKey = key.trim();
      return { kind, key: _resolvedApiKey };
    }
  }

  _resolvedBackend = "exa_free";
  _resolvedApiKey = null;
  return { kind: "exa_free" };
}

// Allow tests to reset the cached backend
export function _resetSearchBackend(): void {
  _resolvedBackend = null;
  _resolvedApiKey = null;
}

// 鈹€鈹€ API backends 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function searchSerper(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: numResults }),
    signal,
  });
  if (!resp.ok) throw new Error(`Serper HTTP ${resp.status}`);
  const data = await resp.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.organic ?? []).slice(0, numResults).map((r) => ({
    title: normalizeResultTitle(r.title ?? "", r.link ?? "", [r.snippet ?? ""]),
    url: r.link ?? "",
    highlights: r.snippet ? [r.snippet] : [],
  }));
}

async function searchTavily(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: numResults }),
    signal,
  });
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
  const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, numResults).map((r) => ({
    title: normalizeResultTitle(r.title ?? "", r.url ?? "", [r.content ?? ""]),
    url: r.url ?? "",
    highlights: r.content ? [r.content] : [],
  }));
}

async function searchExaApi(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, numResults, type: "auto" }),
    signal,
  });
  if (!resp.ok) throw new Error(`Exa API HTTP ${resp.status}`);
  const data = await resp.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (data.results ?? []).slice(0, numResults).map((r) => ({
    title: normalizeResultTitle(r.title ?? "", r.url ?? "", [r.text ?? ""]),
    url: r.url ?? "",
    highlights: r.text ? [r.text] : [],
  }));
}

async function searchBrave(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(numResults) });
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
    signal,
  });
  if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}`);
  const data = await resp.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? []).slice(0, numResults).map((r) => ({
    title: normalizeResultTitle(r.title ?? "", r.url ?? "", [r.description ?? ""]),
    url: r.url ?? "",
    highlights: r.description ? [r.description] : [],
  }));
}

// 鈹€鈹€ Exa free MCP 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function searchExaFreeMcp(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const resp = await fetch("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, type: "auto", numResults, livecrawl: "fallback" },
      },
    }),
    signal,
  });

  if (!resp.ok) throw new Error(`Exa MCP HTTP ${resp.status}`);

  const body = await resp.text();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.substring(6)) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = data?.result?.content?.[0]?.text;
      if (text) {
        const parsed = parseSearchResultsText(text);
        if (parsed.length > 0) return parsed.slice(0, numResults);
        return [{
          title: normalizeResultTitle("Exa Search Results", "", [text]),
          url: "",
          highlights: [text],
        }];
      }
    } catch { /* skip malformed lines */ }
  }
  throw new Error("Exa MCP returned no results");
}

// 鈹€鈹€ Parallel Web Search MCP 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const PARALLEL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let _parallelInitialized = false;

async function parallelMcpCall(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const resp = await fetch(PARALLEL_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "User-Agent": PARALLEL_UA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!resp.ok) throw new Error(`Parallel MCP HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function searchParallelFreeMcp(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!_parallelInitialized) {
    await parallelMcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "swarmflow", version: "1.0" },
    }, signal);
    _parallelInitialized = true;
  }

  const resp = await parallelMcpCall("tools/call", {
    name: "web_search",
    arguments: { objective: query, search_queries: [query] },
  }, signal);

  const content = (resp as any)?.result?.content as Array<{ type?: string; text?: string }> | undefined;
  if (!content) throw new Error("Parallel MCP returned no content");

  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (!text) throw new Error("Parallel MCP returned empty text");

  const parsed = parseSearchResultsText(text);
  if (parsed.length > 0) return parsed.slice(0, numResults);

  return [{
    title: normalizeResultTitle("Parallel Search Results", "", [text]),
    url: "",
    highlights: [text],
  }];
}

// 鈹€鈹€ DuckDuckGo lite 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const DDG_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];

const DDG_ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,es;q=0.8",
  "en-GB,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.5",
];

let _lastDdgSearch = 0;

async function searchDuckDuckGo(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  // Rate limiting: 500-2000ms random gap between requests
  const minGap = 500 + Math.floor(Math.random() * 1500);
  const elapsed = Date.now() - _lastDdgSearch;
  if (elapsed < minGap) {
    await new Promise((r) => setTimeout(r, minGap - elapsed));
  }
  _lastDdgSearch = Date.now();

  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const ua = DDG_USER_AGENTS[Math.floor(Math.random() * DDG_USER_AGENTS.length)];
  const lang = DDG_ACCEPT_LANGUAGES[Math.floor(Math.random() * DDG_ACCEPT_LANGUAGES.length)];

  const resp = await fetch(url, {
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": lang,
      "Accept-Encoding": "identity",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0",
    },
    signal,
  });

  if (!resp.ok && resp.status !== 202) {
    throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  }

  const html = await resp.text();
  return parseDdgLiteResults(html, numResults);
}

function parseDdgLiteResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // <a ... href="..." ... class='result-link'>Title</a>
  const linkRe = /<a[^>]*href=['"]([^'"]*)['"]\s*[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  // <td class='result-snippet'>...</td>
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = m[1].replace(/&amp;/g, "&");
    const title = m[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
    let finalUrl = rawUrl;
    if (rawUrl.includes("uddg=")) {
      try {
        const uddg = new URL("https://duckduckgo.com" + rawUrl).searchParams.get("uddg");
        if (uddg) finalUrl = uddg;
      } catch { /* keep rawUrl */ }
    }
    links.push({ url: finalUrl, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: normalizeResultTitle(links[i].title, links[i].url, [snippets[i] ?? ""]),
      url: links[i].url,
      highlights: snippets[i] ? [snippets[i]] : [],
    });
  }

  return results;
}

// 鈹€鈹€ Main executor 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function toolWebSearch(
  query: string,
  numResults?: number,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const max = Math.min(Math.max(numResults ?? 5, 1), 20);
  const backend = resolveBackend();

  if (opts.signal?.aborted) {
    return "ERROR: web_search was interrupted.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onExternal = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternal, { once: true });

  try {
    const signal = controller.signal;

    // 1. API key backends
    if (backend.key) {
      switch (backend.kind) {
        case "serper": return formatResults(await searchSerper(query, max, backend.key, signal), query);
        case "tavily": return formatResults(await searchTavily(query, max, backend.key, signal), query);
        case "exa_api": return formatResults(await searchExaApi(query, max, backend.key, signal), query);
        case "brave": return formatResults(await searchBrave(query, max, backend.key, signal), query);
      }
    }

    // 2. Exa free MCP
    try {
      const results = await searchExaFreeMcp(query, max, signal);
      return formatResults(results, query);
    } catch {
      if (signal.aborted) throw new Error("aborted");
    }

    // 3. Parallel Web Search MCP
    try {
      const results = await searchParallelFreeMcp(query, max, signal);
      return formatResults(results, query);
    } catch {
      if (signal.aborted) throw new Error("aborted");
    }

    // 4. DuckDuckGo lite
    try {
      const results = await searchDuckDuckGo(query, max, signal);
      if (results.length > 0) return formatResults(results, query);
    } catch {
      if (signal.aborted) throw new Error("aborted");
    }

    return (
      "Web search failed —no results from any backend.\n\n" +
      "For more reliable search, set one of these environment variables:\n" +
      "  SERPER_API_KEY (serper.dev —2,500 free queries/month)\n" +
      "  TAVILY_API_KEY (tavily.com —1,000 free queries/month)\n" +
      "  EXA_API_KEY (exa.ai —2,000 free queries one-time)\n" +
      "  BRAVE_SEARCH_API_KEY (brave.com/search/api)"
    );
  } catch (e) {
    if (opts.signal?.aborted) return "ERROR: web_search was interrupted.";
    return `ERROR: Web search failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternal);
  }
}
