/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

import type { PresentationPanelProps } from "../conversation-types.js";
import { PresentationEntryComponent } from "./presentation-entry.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });

/**
 * Brand wordmark. Horizontally centered within its container; the
 * caller controls vertical placement (welcome screen renders this in
 * an absolutely-positioned layer keyed to absolute terminal height, so
 * it never shifts when the conversation viewport resizes).
 */
export function LogoBlock(
  { lines, color }: { lines: readonly string[]; color: string },
): React.ReactNode {
  return (
    <box flexDirection="column" width="100%" alignItems="center" paddingBottom={1}>
      {lines.map((line, index) => (
        <text key={`logo-${index}`} fg={color} content={line} />
      ))}
    </box>
  );
}

/**
 * Pure entry list — renders logo, sub-session indicator, and conversation entries.
 * Does NOT own a scrollbox; the parent (OpenTuiScreen) wraps this in a ScrollViewport.
 */
function PresentationPanelInner(
  {
    items,
    colors,
    theme,
    contentWidth,
    markdownMode,
    diffDisplayMode,
    markdownStyle,
    selectedChildId,
    showLogoInScroll,
    branding,
    onEntryClick,
    onAgentClick,
  }: PresentationPanelProps,
): React.ReactNode {
  // Logo is no longer rendered here: the welcome wordmark lives in an
  // absolutely-positioned layer in OpenTuiScreen (keyed to terminal
  // height) so it stays put when the conversation viewport resizes.
  // `showLogoInScroll` / `branding` are kept on the prop type for the
  // caller's gating but are intentionally unused in this subtree.
  void showLogoInScroll;
  void branding;
  return (
    <box flexDirection="column" gap={0}>
      {selectedChildId ? (
        <box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <text fg={colors.accent} attributes={ATTRS_BOLD} content={`SUB-SESSION ${selectedChildId}`} />
          <text fg={colors.dim} content="Esc back to primary session · Ctrl+C interrupt child turn" />
        </box>
      ) : null}
      {items.map((entry) => (
        <PresentationEntryComponent
          key={entry.id}
          entry={entry}
          colors={colors}
          theme={theme}
          contentWidth={contentWidth}
          markdownMode={markdownMode}
          diffDisplayMode={diffDisplayMode}
          markdownStyle={markdownStyle}
          onEntryClick={onEntryClick}
          onAgentClick={onAgentClick}
        />
      ))}
    </box>
  );
}

export const PresentationPanel = React.memo(
  PresentationPanelInner,
  (previous, next) => (
    previous.items === next.items
    && previous.processing === next.processing
    && previous.contentWidth === next.contentWidth
    && previous.markdownMode === next.markdownMode
    && previous.diffDisplayMode === next.diffDisplayMode
    && previous.colors === next.colors
    && previous.theme === next.theme
    && previous.markdownStyle === next.markdownStyle
    && previous.selectedChildId === next.selectedChildId
    && previous.showLogoInScroll === next.showLogoInScroll
    && previous.branding === next.branding
  ),
);
