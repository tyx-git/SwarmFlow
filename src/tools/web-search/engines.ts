/** 搜索后端的优先级解析与各引擎实现（API key / 免费 MCP / DuckDuckGo 抓取）。 */
import { type SearchResult, normalizeResultTitle, parseSearchResultsText } from "./results.js";

// ------------------------------------------------------------------
// 工具定义
// ------------------------------------------------------------------

type BackendKind = "serper" | "tavily" | "exa_api" | "brave" | "exa_free" | "parallel_free" | "ddg";

interface ApiBackend {
  kind: "serper" | "tavily" | "exa_api" | "brave";
  key: string;
}

let _resolvedBackend: BackendKind | null = null;

let _resolvedApiKey: string | null = null;

export function resolveBackend(): { kind: BackendKind; key?: string } {
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

export async function searchSerper(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
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

export async function searchTavily(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
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

export async function searchExaApi(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
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

export async function searchBrave(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
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

export async function searchExaFreeMcp(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
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

export async function searchParallelFreeMcp(
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

export async function searchDuckDuckGo(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
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
