import { describe, expect, it } from "bun:test";
import { normalizeEndpointUrl } from "../src/commands.js";

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

  it("reports changed=true when only trailing slashes were trimmed", () => {
    expect(normalizeEndpointUrl("https://api.example.com/v1/")).toEqual({
      baseUrl: "https://api.example.com/v1",
      protocol: null,
      changed: true,
    });
  });
});
