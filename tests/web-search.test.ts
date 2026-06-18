import { afterEach, describe, expect, it, mock } from "bun:test";

import { _resetSearchBackend, toolWebSearch } from "../src/tools/web-search.js";

describe("toolWebSearch", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SERPER_API_KEY: process.env.SERPER_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
    BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetSearchBackend();
    mock.restore();
  });

  function clearApiKeys(): void {
    delete process.env.SERPER_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    _resetSearchBackend();
  }

  it("parses Exa MCP text into individual search results", async () => {
    clearApiKeys();
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://mcp.exa.ai/mcp");
      return new Response(
        [
          "event: message",
          `data: ${JSON.stringify({
            result: {
              content: [{
                text: [
                  "Title: Introducing GPT-5.5 - OpenAI",
                  "URL: https://openai.com/index/introducing-gpt-5-5/",
                  "Published: 2026-04-23T00:00:00.000Z",
                  "Author: OpenAI",
                  "Highlights:",
                  "GPT-5.5 and GPT-5.5 Pro are now available in the API.",
                  "",
                  "Title: OpenAI API changelog",
                  "URL: https://platform.openai.com/docs/changelog",
                  "Highlights:",
                  "API availability updates for current models.",
                ].join("\n"),
              }],
            },
          })}`,
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("OpenAI GPT-5.5 API availability", 5);

    expect(result).toContain('Found 2 results for "OpenAI GPT-5.5 API availability"');
    expect(result).toContain("1. Introducing GPT-5.5 - OpenAI");
    expect(result).toContain("URL: https://openai.com/index/introducing-gpt-5-5/");
    expect(result).toContain("Published: 2026-04-23T00:00:00.000Z");
    expect(result).toContain("Author: OpenAI");
    expect(result).toContain("Highlights:");
    expect(result).toContain("GPT-5.5 and GPT-5.5 Pro are now available in the API.");
    expect(result).toContain("2. OpenAI API changelog");
    expect(result).toContain("URL: https://platform.openai.com/docs/changelog");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves multiline Exa MCP highlights until the next result boundary", async () => {
    clearApiKeys();
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({
        result: {
          content: [{
            text: [
              "Title: World Cup 2026: Latest News, Scores, Analysis | BBC",
              "URL: https://www.bbc.com/sport/football/world-cup",
              "Published: N/A",
              "Author: N/A",
              "Highlights:",
              "World Cup 2026: Latest News, Scores, Analysis | BBC",
              "[...]",
              "## World Cup 2026: Every nation's squad as they are announced",
              "",
              "Every squad for the 2026 World Cup as they are announced.",
              "",
              "---",
              "",
              "Title: World Cup 2026 news and live updates - Sky Sports",
              "URL: https://www.skysports.com/football/live-blog/example",
              "Published: 2026-05-19T13:20:00.000Z",
              "Highlights:",
              "Sorry, this blog is currently unavailable. Please try again later.",
            ].join("\n"),
          }],
        },
      })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("2026 World Cup latest news", 5);

    expect(result).toContain("1. World Cup 2026: Latest News, Scores, Analysis | BBC");
    expect(result).toContain("## World Cup 2026: Every nation's squad as they are announced");
    expect(result).toContain("Every squad for the 2026 World Cup as they are announced.");
    expect(result).toContain("2. World Cup 2026 news and live updates - Sky Sports");
    expect(result).toContain("Sorry, this blog is currently unavailable. Please try again later.");
  });

  it("falls back to raw Exa MCP text when structured parsing is not possible", async () => {
    clearApiKeys();
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({ result: { content: [{ text: "unstructured search answer" }] } })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("unstructured", 3);

    expect(result).toContain('Found 1 results for "unstructured"');
    expect(result).toContain("1. Exa Search Results");
    expect(result).toContain("Highlights:");
    expect(result).toContain("unstructured search answer");
  });

  it("falls back from N/A titles to highlight text", async () => {
    clearApiKeys();
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({
        result: {
          content: [{
            text: [
              "Title: N/A",
              "URL: https://www.arxiv.org/pdf/2506.13585",
              "Highlights:",
              "arXiv:2506.13585v1 [cs.CL] 16 Jun 2025",
            ].join("\n"),
          }],
        },
      })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("arxiv", 3);

    expect(result).toContain("1. arXiv:2506.13585v1 [cs.CL] 16 Jun 2025");
    expect(result).not.toContain("1. N/A");
  });

  it("keeps a first highlight even when it repeats the title", async () => {
    clearApiKeys();
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({
        result: {
          content: [{
            text: [
              "Title: Example title",
              "URL: https://example.com/repeated",
              "Highlights:",
              "Example title",
              "",
              "Additional supporting detail.",
            ].join("\n"),
          }],
        },
      })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("repeat", 3);

    expect(result).toContain("1. Example title");
    expect(result).toContain("Highlights:");
    expect(result).toContain("Example title");
  });

  it("shows multiple highlight blocks when more than one highlight is present", async () => {
    clearApiKeys();
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({
        result: {
          content: [{
            text: JSON.stringify([{
              Title: "Example result",
              URL: "https://example.com/article",
              Highlights: [
                "Zero highlight text.",
                "First highlight text.",
                "Second highlight text.",
                "Third highlight text.",
              ],
            }]),
          }],
        },
      })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("example", 3);

    expect(result).toContain("Highlights:");
    expect(result).toContain("Zero highlight text.");
    expect(result).toContain("First highlight text.");
    expect(result).toContain("Second highlight text.");
    expect(result).not.toContain("Third highlight text.");
    expect(result).toContain("... 1 more highlight block omitted");
  });

  it("soft-truncates long highlights at a nearby word boundary", async () => {
    clearApiKeys();
    const longHighlight = `${"alpha ".repeat(399)}boundaryword tailword`;
    const fetchMock = mock(async () => new Response(
      `data: ${JSON.stringify({
        result: {
          content: [{
            text: JSON.stringify([{
              Title: "Long result",
              URL: "https://example.com/long",
              Highlights: longHighlight,
            }]),
          }],
        },
      })}\n`,
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebSearch("long", 3);

    expect(result).toContain("boundaryword…");
    expect(result).not.toContain("boundar…");
    expect(result).not.toContain("tailword");
  });
});
