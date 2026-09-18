/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

interface TurnSummaryEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
}

function TurnSummaryEntryInner(
  { entry, colors, contentWidth }: TurnSummaryEntryProps,
): React.ReactNode {
  const text = entry.turnSummaryText ?? "";
  const interrupted = entry.turnSummaryInterrupted ?? false;
  const hints = entry.turnSummaryHints ?? [];
  const label = ` ${text} `;
  const totalDashes = Math.max(0, contentWidth - label.length - 1);
  const leftDashes = Math.max(0, Math.floor((totalDashes - 1) / 2));
  const rightDashes = totalDashes - leftDashes;
  const line = " " + "─".repeat(leftDashes) + label + "─".repeat(rightDashes);
  const lineColor = interrupted ? colors.waitingStatus : colors.dim;

  return (
    <box flexDirection="column" width="100%" paddingTop={1} gap={0}>
      {hints.length > 0 ? (
        <box flexDirection="column" paddingLeft={2} gap={0}>
          {hints.map((hint, idx) => (
            <text key={idx} fg={colors.dim} content={`└ ${hint}`} />
          ))}
        </box>
      ) : null}
      <text fg={lineColor} content={line} />
    </box>
  );
}

export const TurnSummaryEntry = React.memo(
  TurnSummaryEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
