/** web_search 工具定义、直通车处理器与主执行器。 */
import type { ToolDef } from "../../providers/types.js";
import { resolveBackend, searchBrave, searchDuckDuckGo, searchExaApi, searchExaFreeMcp, searchParallelFreeMcp, searchSerper, searchTavily } from "./engines.js";
import { formatResults } from "./results.js";

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

const SEARCH_TIMEOUT_MS = 25_000;

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

    // 1. API key 后端
    if (backend.key) {
      switch (backend.kind) {
        case "serper": return formatResults(await searchSerper(query, max, backend.key, signal), query);
        case "tavily": return formatResults(await searchTavily(query, max, backend.key, signal), query);
        case "exa_api": return formatResults(await searchExaApi(query, max, backend.key, signal), query);
        case "brave": return formatResults(await searchBrave(query, max, backend.key, signal), query);
      }
    }

    // 2. Exa 免费 MCP
    try {
      const results = await searchExaFreeMcp(query, max, signal);
      return formatResults(results, query);
    } catch {
      if (signal.aborted) throw new Error("aborted");
    }

    // 3. Parallel 免费 Web Search MCP
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
