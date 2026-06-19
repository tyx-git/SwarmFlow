import { describe, expect, it } from "bun:test";

import { buildToolResultArtifacts, inferToolResultLanguage } from "./tool-result-artifacts.js";

const COLORS = {
  background: "transparent",
  panel: "transparent",
  userBg: "#1f1c26",
  border: "#2a2630",
  separator: "#2a2630",
  scrollbarThumb: "#d0d6e0",
  scrollbarTrack: "#2a263044",
  text: "#d0d6e0",
  dim: "#636a76",
  muted: "#454a54",
  accent: "#ffb703",
  orange: "#fb8500",
  red: "#f05030",
  magenta: "#e81860",
  purple: "#a010a0",
  yellow: "#e8c468",
  green: "#73a942",
  cyan: "#9cd4cc",
  thinking: "#454a54",
  toolTime: "#8a8078",
  readyStatus: "#fb8500",
  thinkingStatus: "#6e4890",
  workingStatus: "#8ab4f8",
  generatingStatus: "#ffb703",
  waitingStatus: "#e8c468",
  closingStatus: "#4d4843",
  errorStatus: "#f05030",
} as const;

describe("tool-result artifacts", () => {
  it("builds diff previews with full-row backgrounds for additions and deletions", () => {
    const artifacts = buildToolResultArtifacts({
      text: " 12 +const answer = 42;\n 13 -const answer = 0;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts[0]?.rowBackgroundColor).toBe("#285438");
    expect(artifacts[1]?.rowBackgroundColor).toBe("#6a3232");
    expect(artifacts[0]?.content.chunks[0]?.text).toContain("12 ");
    expect(artifacts[0]?.content.chunks[0]?.fg?.toString()).toBe(artifacts[0]?.content.chunks[1]?.fg?.toString());
    expect(artifacts[1]?.content.chunks[0]?.fg?.toString()).toBe(artifacts[1]?.content.chunks[1]?.fg?.toString());
  });

  it("omits diff hunk header rows from the rendered preview", () => {
    const artifacts = buildToolResultArtifacts({
      text: "   @@ -61,4 +61,3 @@\n 61 +const answer = 42;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content.toString()).not.toContain("@@");
  });

  it("syntax-highlights unchanged context rows in diff previews", () => {
    const artifacts = buildToolResultArtifacts({
      text: " 14  const answer = 42;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content.chunks.length).toBeGreaterThan(2);
  });

  it("keeps dim tool results plain without diff backgrounds", () => {
    const artifacts = buildToolResultArtifacts({
      text: "Spawned 2 sub-agent(s)",
      dim: true,
      colors: COLORS,
    });

    expect(artifacts.every((artifact) => artifact.rowBackgroundColor === undefined)).toBe(true);
  });

  it("infers syntax language from tool metadata path", () => {
    expect(
      inferToolResultLanguage({
        kind: "tool_result",
        text: "",
        meta: { toolMetadata: { path: "/tmp/example.rs" } },
      }),
    ).toBe("rust");
  });

  it("adds continuation diff prefixes when long changed lines wrap", () => {
    const artifacts = buildToolResultArtifacts({
      text: ' 33 +            className="rounded-full border border-[color:var(--line)] px-3 py-1 text-xs font-medium text-slatepaper-300 transition hover:border-[color:var(--accent)] hover:text-[#fff0da]"',
      toolMetadata: {
        path: "/tmp/example.tsx",
        tui_preview: { kind: "diff" },
      },
      wrapWidth: 120,
      colors: COLORS,
    });

    const textOf = (a: (typeof artifacts)[number]) => a?.content.chunks.map((c) => c.text).join("") ?? "";
    const allText = artifacts.map((a) => textOf(a)).join("\n");
    expect(artifacts.length).toBeGreaterThan(1);
    expect(allText).toContain("hover:border");
    expect(allText).toContain("hover:text");
    expect(artifacts.every((artifact) => artifact.rowBackgroundColor === "#285438")).toBe(true);
  });
});
