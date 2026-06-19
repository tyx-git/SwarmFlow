/** @jsxImportSource @opentui/react */

import React, { useState, useEffect, useRef } from "react";

import { RGBA, createTextAttributes } from "@opentui/core";
import type { PresentationEntry } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";

interface ThinkingEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
}

const LABEL_COLOR = "#7a8098";
const LABEL_RGBA = RGBA.fromHex(LABEL_COLOR);
const BODY_COLOR = "#5a6078";
const ATTRS_ITALIC = createTextAttributes({ italic: true });

const LABEL_TEXT = "Thinking";

function ThinkingEntryInner(
  { entry, colors }: ThinkingEntryProps,
): React.ReactNode {
  const active = entry.state === "active";
  const isError = entry.state === "error";
  const fullText = entry.thinkingFullText ?? "";
  const hasBody = fullText.trim().length > 0;
  const lines = fullText.split("\n");

  // Auto-expand while streaming, auto-collapse when done
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const wasActive = useRef(active);

  useEffect(() => {
    if (wasActive.current && !active) {
      // Streaming just finished → auto-collapse
      setManualToggle(false);
    }
    wasActive.current = active;
  }, [active]);

  const expanded = manualToggle !== null ? manualToggle : active;
  const toggle = () => setManualToggle((prev) => !(prev !== null ? prev : active));

  const shimmer = useShimmer(LABEL_TEXT, LABEL_RGBA, active, ATTRS_ITALIC);
  const chevron = expanded ? "▼ " : "▶ ";

  return (
    <box flexDirection="column" paddingTop={1} width="100%" gap={0}>
      <box
        flexDirection="row"
        width="100%"
        cursor="pointer"
        onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); toggle(); }}
      >
        <text fg={LABEL_COLOR} content={chevron} flexShrink={0} />
        {active ? (
          <text content={shimmer} flexShrink={0} />
        ) : (
          <text
            fg={LABEL_COLOR}
            attributes={ATTRS_ITALIC}
            content={LABEL_TEXT}
            flexShrink={0}
          />
        )}
      </box>

      {/* Expanded body */}
      {expanded && hasBody ? (
        <box flexDirection="column" paddingLeft={2} gap={0}>
          {lines.map((line, idx) => (
            <text
              key={idx}
              fg={BODY_COLOR}
              attributes={ATTRS_ITALIC}
              content={line}
              wrapMode="char"
            />
          ))}
        </box>
      ) : null}

      {/* Interrupted marker */}
      {isError ? (
        <text
          fg={colors.orange}
          content="[Interrupted — not sent to model]"
        />
      ) : null}
    </box>
  );
}

export const ThinkingEntry = React.memo(
  ThinkingEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
