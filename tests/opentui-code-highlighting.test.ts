import { afterEach, describe, expect, it } from "vitest";

import {
  destroyTreeSitterClient,
  getTreeSitterClient,
} from "@opentui/core";
import {
  inferCodeFiletype,
  infoStringToFiletype,
} from "../external/opentui/forked/core/lib/tree-sitter/resolve-ft.js";
import { registerSwarmFlowTreeSitterParsers } from "../external/opentui/tree-sitter-parsers.js";
import { buildCommandStyledText } from "../external/opentui/components/syntax-highlight-utils.js";
import { RGBA } from "@opentui/core";
import { highlightToChunks } from "../external/opentui/forked/patch-opentui-markdown.js";

afterEach(async () => {
  await destroyTreeSitterClient();
});

describe("OpenTUI code block language resolution", () => {
  it.each([
    ["ts", "typescript"],
    ["javascript", "javascript"],
    ["python3", "python"],
    ["shell-session", "bash"],
    ["pwsh", "powershell"],
  ])("maps fenced info string %s to %s", (info, expected) => {
    expect(infoStringToFiletype(info)).toBe(expected);
  });

  it.each([
    ["const answer = 42", "typescript"],
    ["def greet(name):\n    return name", "python"],
    ["git status", "bash"],
    ["$value = Get-Item .", "powershell"],
  ])("infers an unlabelled code block as %s", (content, expected) => {
    expect(inferCodeFiletype(content)).toBe(expected);
  });

  it("registers local Python, Bash, and PowerShell parsers", async () => {
    await registerSwarmFlowTreeSitterParsers();
    const client = getTreeSitterClient();

    const samples: Array<[string, string]> = [
      ["python", "def greet(name):\n    return name"],
      ["bash", "for file in *.ts; do echo \"$file\"; done"],
      ["powershell", "$value = Get-Item ."],
    ];

    for (const [filetype, content] of samples) {
      const result = await client.highlightOnce(content, filetype);
      expect(result.error, `${filetype} parser error`).toBeUndefined();
      expect(result.highlights?.length ?? 0, `${filetype} should have highlights`).toBeGreaterThan(0);
    }
  });

  it("highlights fenced Python and shell blocks through Markdown injections", async () => {
    await registerSwarmFlowTreeSitterParsers();
    const client = getTreeSitterClient();
    const result = await client.highlightOnce(
      "```python\ndef greet(name):\n    return name\n```\n\n```bash\ngit status\n```",
      "markdown",
    );

    expect(result.error).toBeUndefined();
    expect(result.highlights?.some((highlight) => highlight[3]?.injectionLang === "python")).toBe(true);
    expect(result.highlights?.some((highlight) => highlight[3]?.injectionLang === "bash")).toBe(true);
  });

  it("keeps the non-Tree-sitter fallback for common languages", () => {
    for (const [language, source] of [["json", "{\"ok\": true}"], ["rust", "fn main() {}"], ["go", "package main"]]) {
      expect(highlightToChunks(source, language)?.length ?? 0, language).toBeGreaterThan(0);
    }
  });

  it("highlights shell command titles and ripgrep source-result prefixes", () => {
    const command = buildCommandStyledText(
      'rg -n -F "git" src/commands/commands.ts --glob "*.ts" | Select-Object -First 240',
      {
        mode: "command",
        fallbackFg: RGBA.fromHex("#ffffff"),
      },
    );
    const commandText = command.chunks.map((chunk) => chunk.text).join("");
    expect(commandText).toContain("rg");
    expect(command.chunks.some((chunk) => chunk.text.includes("rg"))).toBe(true);
    expect(new Set(command.chunks.map((chunk) => chunk.fg?.toString())).size).toBeGreaterThan(1);

    const source = buildCommandStyledText(
      "src/commands/commands.ts:2313:  Run `git diff` for changes",
      { mode: "output", fallbackFg: RGBA.fromHex("#ffffff") },
    );
    expect(source.chunks.some((chunk) => chunk.text.includes("src/commands/commands.ts"))).toBe(true);
    expect(source.chunks.some((chunk) => chunk.text.includes(":2313:"))).toBe(true);
  });

  it("recognizes command output even when the result is dimmed", () => {
    const output = buildCommandStyledText("src/tools/basic.ts:1116: const isPwsh = true", {
      mode: "output",
      language: "bash",
      fallbackFg: RGBA.fromHex("#ffffff"),
      pathFg: RGBA.fromHex("#74C7EC"),
      lineFg: RGBA.fromHex("#FFAF5F"),
    });
    expect(output.chunks[0]?.text).toBe("src/tools/basic.ts");
    expect(output.chunks[1]?.text).toBe(":1116:");
  });

  it("keeps shell prompts and Windows source paths while highlighting", () => {
    const command = buildCommandStyledText("❯ rg -n \"git\" src/commands/commands.ts", {
      mode: "command",
      fallbackFg: RGBA.fromHex("#ffffff"),
    });
    expect(command.chunks.map((chunk) => chunk.text).join("")).toBe("❯ rg -n \"git\" src/commands/commands.ts");
    expect(command.chunks.some((chunk) => chunk.text.includes("rg"))).toBe(true);

    const windows = buildCommandStyledText(
      "C:\\work\\src\\main.ts:42:const answer = 42",
      { mode: "output", fallbackFg: RGBA.fromHex("#ffffff") },
    );
    expect(windows.chunks[0]?.text).toBe("C:\\work\\src\\main.ts");
    expect(windows.chunks[1]?.text).toBe(":42:");
  });

});
