import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";

import { InputArea } from "../../external/opentui/input/input-area.js";
import { createComposerTokenVisuals } from "../../external/opentui/composer-tokens.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { createUiText } from "../../src/ui/text.js";

describe("status bar session name", () => {
  it("shows up to 16 characters before truncating", async () => {
    const theme = createDisplayTheme("dark");
    const visuals = createComposerTokenVisuals(theme.colors);
    const setup = await createTestRenderer({ width: 120, height: 12, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(InputArea, {
        inputRef: React.createRef<TextareaRenderable>(),
        processing: false,
        pendingAsk: false,
        selectedChildId: null,
        phase: "idle",
        modelName: "test-model",
        thinkingSuffix: "",
        modelColor: theme.colors.text,
        elapsed: 0,
        cwd: ".",
        hint: null,
        contextTokens: 0,
        contextLimit: 8192,
        cacheInputTokens: 0,
        cacheReadTokens: 0,
        cacheSupported: false,
        sessionName: "0123456789abcdefXYZ",
        contentWidth: 118,
        colors: theme.colors,
        maxInputLines: 3,
        composerTokenVisuals: visuals,
        uiText: createUiText("en"),
        keyBindings: [],
        onSubmit: () => {},
        onModelClick: () => {},
        commandOverlayVisible: false,
        commandPicker: false,
        promptSelect: false,
        promptSecret: false,
      })));
      await setup.flush({ maxPasses: 100 });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("0123456789abcdef");
      expect(frame).not.toContain("0123456789abcdefX");
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      visuals.syntaxStyle.destroy();
      theme.markdownStyle.destroy();
    }
  });
});
