/** @jsxImportSource @opentui/react */

import React, { useState } from "react";
import { osCapabilities } from "../../../../src/platform/index.js";

import { RGBA, createTextAttributes } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { PresentationEntry } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import type { DisplayTheme } from "../../display/theme/index.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
import { ClickablePath } from "./clickable-path.js";
import { InlineResult } from "./inline-result.js";

const EXPLORE_LABEL = "Explore";
const PATH_TOOLS = new Set(["Read", "List", "Edit", "Write"]);

interface ToolGroupEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  theme: DisplayTheme;
  contentWidth: number;
}

function ToolGroupEntryInner(
  { entry, colors, theme, contentWidth }: ToolGroupEntryProps,
): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(() => new Set());
  const active = entry.groupActive ?? false;
  const items = entry.groupEntries ?? [];
  const summary = entry.groupSummary ?? "Explore";

  const toolNameColor = theme.presentation.toolNameColor;
  const toolNameRgba = React.useMemo(() => RGBA.fromHex(toolNameColor), [toolNameColor]);
  const shimmer = useShimmer(EXPLORE_LABEL, toolNameRgba, active, ATTRS_BOLD);

  const indicatorColor = getActivityIndicatorColor(
    { active, error: entry.state === "error", interrupted: entry.toolInterrupted === true },
    theme,
    "tool",
  );

  // See tool-operation-entry.tsx — done-state glyph is per-platform.
  const indicator = active ? "›" : osCapabilities.toolIndicatorGlyph;

  const toggleExpand = () => setExpanded((prev) => !prev);
  const toggleItem = (id: string) => {
    setExpandedItems((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <box flexDirection="column" width="100%" gap={0}>
      {active ? (
        <box
          flexDirection="row"
          width="100%"
        >
          <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
          <text content={shimmer} flexShrink={0} />
          <text content="  " flexShrink={0} />
          <text fg={toolNameColor} attributes={ATTRS_BOLD} content={entry.groupLatestToolName ?? ""} flexShrink={0} />
          <text content="  " flexShrink={0} />
          <text fg={colors.dim} content={entry.groupLatestToolText ?? ""} truncate flexGrow={1} flexShrink={1} />
        </box>
      ) : (
        <box>
          <SelectableRow hoverBackgroundColor={colors.border} onPress={toggleExpand}>
            <box flexDirection="row" width="100%">
              <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
              <text fg={toolNameColor} attributes={ATTRS_BOLD} content={summary} flexShrink={0} />
              <text content=" " flexShrink={0} />
              <text fg={colors.dim} content={expanded ? "▾" : "▸"} flexShrink={0} />
            </box>
          </SelectableRow>
        </box>
      )}

      {/* Expanded detail */}
      {expanded && !active ? (
        <box flexDirection="column" paddingLeft={3} gap={0}>
          {items.map((item) => {
            const name = item.toolDisplayName ?? "?";
            const text = item.toolText ?? "";
            const itemIndicator = osCapabilities.toolIndicatorGlyph;
            const itemColor = getActivityIndicatorColor(
              { active: false, error: item.state === "error", interrupted: item.toolInterrupted === true },
              theme,
              "tool",
            );
            const isPathTool = PATH_TOOLS.has(name);
            const result = item.toolInlineResult;
            return (
              <box key={item.id} flexDirection="column" width="100%">
                <box flexDirection="row" width="100%">
                  <text fg={itemColor} content={`${itemIndicator} `} flexShrink={0} />
                  <text fg={colors.dim} content={name} flexShrink={0} />
                  <text content="  " flexShrink={0} />
                  {isPathTool && text ? (
                    <ClickablePath text={text} baseColor={colors.dim} hoverBg={colors.border} />
                  ) : (
                    <text fg={colors.dim} content={text} truncate flexGrow={1} flexShrink={1} />
                  )}
                </box>
                {result ? (
                  <box paddingLeft={3} width="100%">
                    <InlineResult
                      data={result}
                      colors={colors}
                      contentWidth={Math.max(8, contentWidth - 6)}
                      language={result.language}
                      syntaxMode={result.syntaxMode}
                      expanded={expandedItems.has(item.id)}
                      fullText={item.toolResultFullText}
                      onToggleExpand={() => toggleItem(item.id)}
                    />
                  </box>
                ) : null}
              </box>
            );
          })}
        </box>
      ) : null}
    </box>
  );
}

export const ToolGroupEntry = React.memo(
  ToolGroupEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.theme === next.theme
    && prev.contentWidth === next.contentWidth,
);
