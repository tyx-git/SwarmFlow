/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntryItemProps } from "../conversation-types.js";
import { AssistantEntry } from "../../display/entries/assistant-entry.js";
import { ThinkingEntry } from "./thinking-entry.js";
import { ToolOperationEntry } from "./tool-operation-entry.js";
import { ToolGroupEntry } from "./tool-group-entry.js";
import { UserEntry } from "./user-entry.js";
import { CommandEchoEntry } from "./command-echo-entry.js";
import { SystemEntry } from "./system-entry.js";
import { TurnSummaryEntry } from "./turn-summary-entry.js";
import { TipsEntry } from "./tips-entry.js";

function PresentationEntryInner(
  props: PresentationEntryItemProps,
): React.ReactNode {
  const { entry, colors, interruptionText, theme, contentWidth, diffDisplayMode, markdownStyle, onAgentClick } = props;

  const renderers = {
    user: () => <UserEntry entry={entry} colors={colors} />,
    command_echo: () => <CommandEchoEntry entry={entry} />,
    thinking: () => <ThinkingEntry entry={entry} colors={colors} />,
    tool_operation: () => (
      <ToolOperationEntry
        entry={entry}
        colors={colors}
        theme={theme}
        contentWidth={contentWidth}
        diffDisplayMode={diffDisplayMode}
        onAgentClick={onAgentClick}
      />
    ),
    tool_group: () => (
      <ToolGroupEntry
        entry={entry}
        colors={colors}
        theme={theme}
        contentWidth={contentWidth}
      />
    ),
    assistant: () => (
      <AssistantEntry
        entry={entry}
        colors={colors}
        markdownStyle={markdownStyle}
      />
    ),
    system: () => <SystemEntry entry={entry} colors={colors} theme={theme} />,
    turn_summary: () => (
      <TurnSummaryEntry
        entry={entry}
        colors={colors}
        interruptionText={interruptionText}
      />
    ),
    tips: () => (
      <TipsEntry
        entry={entry}
        colors={colors}
        contentWidth={contentWidth}
      />
    ),
  } satisfies Record<PresentationEntryItemProps["entry"]["kind"], () => React.ReactNode>;

  return (
    <box width="100%" flexShrink={0}>
      {renderers[entry.kind]?.() ?? <box />}
    </box>
  );
}

export const PresentationEntryComponent = React.memo(
  PresentationEntryInner,
  (prev, next) => (
    prev.entry === next.entry
    && prev.diffDisplayMode === next.diffDisplayMode
    && prev.markdownStyle === next.markdownStyle
    && prev.colors === next.colors
    && prev.interruptionText === next.interruptionText
    && prev.theme === next.theme
    && prev.contentWidth === next.contentWidth
  ),
);
