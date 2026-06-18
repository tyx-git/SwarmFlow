import { afterEach, describe, expect, it, mock } from "bun:test";

import { toolWebFetch } from "../src/tools/web-fetch.js";

describe("toolWebFetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it("uses Jina Reader output when available", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://r.jina.ai/https://example.com/");
      return new Response("Title: Example Domain\n\nMarkdown Content:\nHello from Jina", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebFetch("https://example.com");

    expect(result).toContain("# Content from https://example.com/");
    expect(result).toContain("Hello from Jina");
    expect(result).not.toContain("Title: Example Domain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to local extraction when Jina is rate limited", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://r.jina.ai/https://example.com/") {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      if (url === "https://example.com/") {
        return new Response(`
          <html>
            <head><title>Ignored title</title></head>
            <body>
              <nav>Navigation noise</nav>
              <article>
                <h1>Title</h1>
                <p>Hello local</p>
              </article>
            </body>
          </html>
        `, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebFetch("https://example.com", "docs");

    expect(result).toContain("# Content from https://example.com/");
    expect(result).toContain("# Title");
    expect(result).toContain("Hello local");
    expect(result).not.toContain("Navigation noise");
    expect(result).not.toContain("Looking for: docs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects local hosts before any network request", async () => {
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebFetch("http://localhost:3000");

    expect(result).toContain("ERROR: Refusing to fetch local hostname");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects redirects to private IP addresses", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://r.jina.ai/https://example.com/") {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      if (url === "https://example.com/") {
        return new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await toolWebFetch("https://example.com");

    expect(result).toContain("ERROR: Redirect target rejected");
    expect(result).toContain("private IP address");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
