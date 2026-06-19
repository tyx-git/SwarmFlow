/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { ScrollViewport } from "../../display/primitives/scroll-viewport.js";
import { SectionHeader } from "../../display/primitives/section-header.js";

interface DetailThinkingTabProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  scrollRef: React.RefObject<any>;
}

function DetailThinkingTabInner(
  { entry, colors, scrollRef }: DetailThinkingTabProps,
): React.ReactNode {
  const text = entry.thinkingFullText ?? "";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <SectionHeader label="Thinking" color={colors.dim} paddingLeft={2} paddingBottom={1} />
      <ScrollViewport colors={colors} scrollRef={scrollRef}>
        <box paddingLeft={2} paddingRight={2}>
          <text fg={colors.dim} content={text} />
        </box>
      </ScrollViewport>
    </box>
  );
}

export const DetailThinkingTab = React.memo(
  DetailThinkingTabInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
