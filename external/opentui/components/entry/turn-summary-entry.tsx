/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { ErrorMessage } from "../../display/primitives/error-message.js";

interface TurnSummaryEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  interruptionText: string;
}

function TurnSummaryEntryInner(
  { entry, colors, interruptionText }: TurnSummaryEntryProps,
): React.ReactNode {
  const interrupted = entry.turnSummaryInterrupted ?? false;
  const hints = entry.turnSummaryHints ?? [];

  // The composer already shows the completed turn's "Worked for ..." status.
  // Keep interruption details in the transcript, but avoid duplicating the
  // normal completion status as a full-width divider.
  if (!interrupted) return null;

  return (
    <box flexDirection="column" width="100%" paddingTop={1} gap={0}>
      <ErrorMessage text={interruptionText} colors={colors} />
      {hints.length > 0 ? (
        <box flexDirection="column" paddingLeft={2} gap={0}>
          {hints.map((hint, idx) => (
            <text key={idx} fg={colors.dim} content={`└ ${hint}`} />
          ))}
        </box>
      ) : null}
    </box>
  );
}

export const TurnSummaryEntry = React.memo(
  TurnSummaryEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.interruptionText === next.interruptionText,
);
