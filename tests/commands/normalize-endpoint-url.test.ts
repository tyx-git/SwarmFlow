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

  it("reports changed=true when only trailing slashes were trimmed", () => {
    expect(normalizeEndpointUrl("https://api.example.com/v1/")).toEqual({
      baseUrl: "https://api.example.com/v1",
      protocol: null,
      changed: true,
    });
  });
});
