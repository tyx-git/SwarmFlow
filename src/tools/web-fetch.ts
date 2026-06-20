/**
 * Web fetch 工具 — 获取 URL 内容并转换 HTML 为可读文本。
 *
 * 默认路径：
 *  1. 尝试 Jina Reader 以获得更高质量的提取
 *  2. 在速率限制或网络故障时回退到本地 fetch/提取路径
 */

import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { ToolDef } from "../providers/base.js";
import { truncateMiddle } from "./shared.js";

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB raw HTML
const OUTPUT_MAX_CHARS = 100_000;
const JINA_READER_PREFIX = "https://r.jina.ai/";
const LOCAL_MAX_REDIRECTS = 10;

// ------------------------------------------------------------------
// 工具定义
// ------------------------------------------------------------------

export const WEB_FETCH: ToolDef = {
  name: "web_fetch",
  description:
    "get content from url and return it as readable text." +
    "first, use a high-quality remote extractor, and if necessary, fall back to local extraction." +
    "the HTML page will be converted into text similar to markdown.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "the URL to get (must be http or https).",
      },
      prompt: {
        type: "string",
        description:
          "optional description, indicating what information to look for." +
          "(included as a hint in the output header)",
      },
    },
    required: ["url"],
  },
  summaryTemplate: "{agent} are fetching {url}",
  tuiPolicy: { partialReveal: { completeArgs: ["url"] } },
};

// ------------------------------------------------------------------
// HTML 到可读文本转换器
// ------------------------------------------------------------------

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function cleanupText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeNoisyElements(document: Document): void {
  for (const selector of ["script", "style", "noscript", "nav", "header", "footer", "aside"]) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      node.remove();
    }
  }
}

/**
 * 使用低维护 library 链将 HTML 转换为可读的 markdown：
 * Readability 尽可能提取主要文章，Turndown 将
 * 剩余的 HTML 转换为 markdown。如果提取失败，回退到 body HTML。
 */
function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(html);
  removeNoisyElements(document);
  const explicitMain = document.querySelector("article, main")?.innerHTML;
  const article = new Readability(document, { keepClasses: false }).parse();
  const source = explicitMain || article?.content || document.body?.innerHTML || html;
  return cleanupText(turndown.turndown(source));
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function validateFetchUrl(parsed: URL): string | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `only http and https url are supported. get:${parsed.protocol}`;
  }

  if (parsed.username || parsed.password) {
    return "url with embedded credentials (user: pass @ host) is not allowed.";
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "local"
  ) {
    return `refuse to get local host name:${parsed.hostname}`;
  }

  const ipKind = isIP(hostname);
  if (ipKind === 4 && isPrivateIpv4(hostname)) {
    return `refuse to get a private ip address：${parsed.hostname}`;
  }
  if (ipKind === 6 && isPrivateIpv6(hostname)) {
    return `refuse to get a private ip address：${parsed.hostname}`;
  }

  return null;
}

// ------------------------------------------------------------------
// 执行器
// ------------------------------------------------------------------

export async function toolWebFetch(
  url: string,
  prompt?: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `error: invalid url:${url}`;
  }

  const validationError = validateFetchUrl(parsed);
  if (validationError) {
    return `error：${validationError}`;
  }

  const normalizedUrl = parsed.toString();

  if (opts.signal?.aborted) {
    return "error: web_fetch was interrupted.";
  }

  try {
    const jinaOutput = await fetchViaJina(normalizedUrl, prompt, opts.signal);
    if (jinaOutput) return jinaOutput;
  } catch {
    // 回退到本地提取。
  }

  if (opts.signal?.aborted) {
    return "error: web_fetch was interrupted.";
  }

  return fetchLocally(normalizedUrl, prompt, opts.signal);
}

/**
 * 三态结果，用于调用者区分超时/中断。
 */
interface FetchFailure {
  kind: "timeout" | "interrupted" | "error";
  message: string;
}

function isFetchFailure(e: unknown): e is FetchFailure {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let externalAborted = false;
  let timedOut = false;

  // 如果调用方已经取消，则短路。
  if (externalSignal?.aborted) {
    throw { kind: "interrupted", message: "web_fetch interrupted before the request started." } satisfies FetchFailure;
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("fetch-timeout"));
  }, FETCH_TIMEOUT_MS);
  const onExternalAbort = () => {
    externalAborted = true;
    controller.abort(new Error("external-abort"));
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    if (externalAborted) {
      throw {
        kind: "interrupted",
        message: "web_fetch was interrupted during the acquisition process.",
      } satisfies FetchFailure;
    }
    if (timedOut || (e instanceof Error && e.name === "AbortError")) {
      throw {
        kind: "timeout",
        message: `the request timed out (more than ${FETCH_TIMEOUT_MS / 1000} seconds.`,
      } satisfies FetchFailure;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function buildOutput(
  url: string,
  body: string,
): string {
  return `# # content from ${url}\n\n${body}`;
}

function normalizeOutput(output: string): string {
  // 对称的头尾截断：长页面通常在顶部有导航，在底部有结论/FAQ/后续步骤
  // 保留两者比丢弃尾部更有用。
  return truncateMiddle(output.trim(), OUTPUT_MAX_CHARS);
}

function stripJinaMetadata(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const markers = [
    "\nMarkdown Content:\n",
    "\nContent:\n",
  ];
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
      const body = normalized.slice(idx + marker.length).trim();
      if (body) return body;
    }
  }
  return normalized;
}

async function fetchViaJina(
  url: string,
  prompt?: string,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  const response = await fetchWithTimeout(JINA_READER_PREFIX + url, {
    headers: {
      "User-Agent": "swarmflow/1.0 (web_fetch tool)",
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
    },
    redirect: "follow",
  }, externalSignal);

  if (!response.ok) {
    if (
      response.status === 403 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return null;
    }
    return `error：HTTP ${response.status} ${response.statusText} for ${url}`;
  }

  const body = normalizeOutput(stripJinaMetadata(await response.text()));
  if (!body) {
    return null;
  }

  return buildOutput(url, body);
}

async function fetchLocallyWithRedirects(
  url: string,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= LOCAL_MAX_REDIRECTS; redirectCount++) {
    const response = await fetchWithTimeout(current, {
      headers: {
        "User-Agent": "swarmflow/1.0 (web_fetch tool)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "manual",
    }, externalSignal);

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { response, finalUrl: current };
    }

    const validationError = validateFetchUrl(next);
    if (validationError) {
      throw {
        kind: "error",
        message: `redirect target denied.：${validationError}`,
      } satisfies FetchFailure;
    }

    current = next.toString();
  }

  throw {
    kind: "error",
    message: `too many redirects（limit ${LOCAL_MAX_REDIRECTS} ）。`,
  } satisfies FetchFailure;
}

async function fetchLocally(
  url: string,
  prompt?: string,
  externalSignal?: AbortSignal,
): Promise<string> {
  let response: Response;
  let finalUrl = url;
  try {
    const fetched = await fetchLocallyWithRedirects(url, externalSignal);
    response = fetched.response;
    finalUrl = fetched.finalUrl;
  } catch (e) {
    if (isFetchFailure(e)) {
      if (e.kind === "interrupted") return `error：${e.message}`;
      if (e.kind === "timeout") return `error：${e.message}`;
      return `error：${e.message}`;
    }
    return `error：fetch false：${e instanceof Error ? e.message : String(e)}`;
  }

  if (!response.ok) {
    return `error：HTTP ${response.status} ${response.statusText} for ${finalUrl}`;
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > FETCH_MAX_CONTENT_LENGTH) {
    return `error：the response is too large（${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB，限制 ${FETCH_MAX_CONTENT_LENGTH / 1024 / 1024} MB）。`;
  }

  let body: string;
  try {
    body = await response.text();
  } catch (e) {
    return `error: failed to read the response body.：${e instanceof Error ? e.message : String(e)}`;
  }

  if (body.length > FETCH_MAX_CONTENT_LENGTH) {
    body = body.slice(0, FETCH_MAX_CONTENT_LENGTH);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHTML = contentType.includes("text/html");
  const isJSON = contentType.includes("application/json");

  let output: string;
  if (isHTML) {
    output = htmlToMarkdown(body);
  } else if (isJSON) {
    try {
      output = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      output = body;
    }
  } else {
    output = body;
  }

  return buildOutput(finalUrl, normalizeOutput(output));
}