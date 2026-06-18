/** @jsxImportSource @opentui/react */

import React, { useState } from "react";
import path from "node:path";

import { browser, osCapabilities } from "../../../src/platform/index.js";

import { RGBA, createTextAttributes } from "@opentui/core";

const ATTRS_UNDERLINE = createTextAttributes({ underline: true });
const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { PresentationEntry } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import type { DisplayTheme } from "../../display/theme/index.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";

const EXPLORE_LABEL = "Explore";
const PATH_TOOLS = new Set(["Read", "List", "Edit", "Write"]);

interface ToolGroupEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  theme: DisplayTheme;
  contentWidth: number;
}

function openFile(filePath: string): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  browser.openFile(resolved);
}

/** A file-path text element with hover highlight and click-to-open. */
function ClickablePath({ text, baseColor, hoverBg }: { text: string; baseColor: string; hoverBg: string }): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexShrink={1}
      backgroundColor={hovered ? hoverBg : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => {
        e.stopPropagation();
        e.preventDefault();
        if (text) openFile(text);
      }}
    >
      <text
        fg={baseColor}
        attributes={ATTRS_UNDERLINE}
        content={text}
        truncate
      />
    </box>
  );
}

function ToolGroupEntryInner(
  { entry, colors, theme, contentWidth }: ToolGroupEntryProps,
): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
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

  // See tool-operation-entry.tsx 鈥?done-state glyph is per-platform.
  const indicator = active ? "鈥? : osCapabilities.toolIndicatorGlyph;

  const toggleExpand = () => setExpanded((prev) => !prev);

  return (
    <box flexDirection="column" width="100%" gap={0}>
      {active ? (
        <box
          flexDirection="row"
          paddingTop={1}
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
        <box paddingTop={1}>
          <SelectableRow hoverBackgroundColor={colors.border} onPress={toggleExpand}>
            <box flexDirection="row" width="100%">
              <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
              <text fg={toolNameColor} attributes={ATTRS_BOLD} content={summary} flexShrink={0} />
              <text content=" " flexShrink={0} />
              <text fg={colors.dim} content={expanded ? "鈻? : "鈻?} flexShrink={0} />
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
            return (
              <box key={item.id} flexDirection="row" width="100%">
                <text fg={itemColor} content={`${itemIndicator} `} flexShrink={0} />
                <text fg={colors.dim} content={name} flexShrink={0} />
                <text content="  " flexShrink={0} />
                {isPathTool && text ? (
                  <ClickablePath text={text} baseColor={colors.dim} hoverBg={colors.border} />
                ) : (
                  <text fg={colors.dim} content={text} truncate flexGrow={1} flexShrink={1} />
                )}
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
