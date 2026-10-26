import { describe, expect, it } from "vitest";
import { normalizeEndpointUrl } from "../../src/commands/provider/endpoint.js";

describe("normalizeEndpointUrl", () => {
  it("strips /chat/completions and infers openai-chat, keeping /v1", () => {
    expect(normalizeEndpointUrl("https://openrouter.ai/api/v1/chat/completions")).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-chat",
      changed: true,
    });
  });

  it("strips /v1/messages (incl. /v1) and infers anthropic", () => {
    expect(normalizeEndpointUrl("https://api.anthropic.com/v1/messages")).toEqual({
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic",
      changed: true,
    });
  });

  it("strips a bare /messages suffix and infers anthropic", () => {
    expect(normalizeEndpointUrl("https://example.com/anthropic/messages")).toEqual({
      baseUrl: "https://example.com/anthropic",
      protocol: "anthropic",
      changed: true,
    });
  });

  it("leaves a clean /v1 base untouched and does not guess the protocol", () => {
    expect(normalizeEndpointUrl("https://openrouter.ai/api/v1")).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: null,
      changed: false,
    });
  });

  it("trims trailing slashes and surrounding whitespace", () => {
    expect(normalizeEndpointUrl("  https://api.example.com/v1/chat/completions/  ")).toEqual({
      baseUrl: "https://api.example.com/v1",
      protocol: "openai-chat",
      changed: true,
    });
  });

  it("is case-insensitive on the suffix", () => {
    expect(normalizeEndpointUrl("https://api.example.com/v1/Chat/Completions")).toEqual({
      baseUrl: "https://api.example.com/v1",
      protocol: "openai-chat",
      changed: true,
    });
  });

  it.each([
    ["openai-chat-completions", "https://api.example/v1/chat/completions/", "https://api.example/v1"],
    ["openai-chat-completions", "https://api.example/v1/", "https://api.example/v1"],
    ["openai-responses", "https://api.example/v1/responses", "https://api.example/v1"],
    ["openai-responses", "https://api.example/v1/", "https://api.example/v1"],
    ["anthropic-messages", "https://api.example/v1/messages", "https://api.example"],
    ["anthropic-messages", "https://api.example/messages", "https://api.example"],
    ["anthropic-messages", "https://api.example/v3/", "https://api.example"],
    ["gemini-generate-content", "https://api.example/v1beta/models/gemini-pro:generateContent", "https://api.example/v1beta"],
    ["gemini-generate-content", "https://api.example/v1beta/", "https://api.example/v1beta"],
  ])("normalizes $1 endpoint/base URL $2", (protocol, input, baseUrl) => {
    expect(normalizeEndpointUrl(input, protocol)).toMatchObject({ baseUrl, changed: baseUrl !== input });
  });

  it("strips a Gemini model endpoint while preserving its versioned base", () => {
    expect(normalizeEndpointUrl(" https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent/ ", "gemini")).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      protocol: "gemini",
      changed: true,
    });
  });

  // 规格依据（不来自实现）：openai SDK 把请求拼成 `<baseURL>/chat/completions` 与
  // `<baseURL>/responses`，OpenAI 兼容服务（含 /v1/models 发现）一律挂在 /v1 下；
  // Anthropic SDK 自己发 `/v1/messages`，所以它的 base 不能带 /v1。
  it.each([
    ["openai-chat-completions", "https://jp.example", "https://jp.example/v1"],
    ["openai-chat-completions", "https://jp.example/", "https://jp.example/v1"],
    ["openai-chat", "http://localhost:11434", "http://localhost:11434/v1"],
    ["openai-responses", "https://jp.nikoapi.xyz", "https://jp.nikoapi.xyz/v1"],
    ["openai-responses", "https://jp.example/gateway", "https://jp.example/gateway/v1"],
    ["openai-responses", "https://jp.example/v2", "https://jp.example/v2"],
    ["openai-chat-completions", "https://jp.example/api/v1", "https://jp.example/api/v1"],
  ])("ensures the /v1 root for %1 base %2", (protocol, input, baseUrl) => {
    expect(normalizeEndpointUrl(input, protocol)).toMatchObject({ baseUrl, changed: baseUrl !== input });
  });

  it.each([
    ["anthropic-messages", "https://claude.example"],
    ["gemini-generate-content", "https://gemini.example"],
  ])("leaves the unversioned %1 base untouched", (protocol, input) => {
    expect(normalizeEndpointUrl(input, protocol)).toMatchObject({ baseUrl: input, changed: false });
  });

  it("does not guess /v1 when no protocol was selected", () => {
    expect(normalizeEndpointUrl("https://jp.example")).toMatchObject({
      baseUrl: "https://jp.example",
      protocol: null,
      changed: false,
    });
  });

  it("does not decorate a value that is not an http(s) URL", () => {
    expect(normalizeEndpointUrl("__custom__", "openai-chat")).toMatchObject({
      baseUrl: "__custom__",
      changed: false,
    });
  });

  it("reports changed=true when only trailing slashes were trimmed", () => {
    expect(normalizeEndpointUrl("https://api.example.com/v1/")).toEqual({
      baseUrl: "https://api.example.com/v1",
      protocol: null,
      changed: true,
    });
  });
});
