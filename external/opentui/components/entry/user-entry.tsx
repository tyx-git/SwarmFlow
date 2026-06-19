/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { StyledText, RGBA, type TextChunk } from "@opentui/core";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

const IMAGE_TOKEN_PATTERN = /\[Image #\d+\]/g;

function buildUserStyledText(text: string, accentColor: string, textColor: string): StyledText {
  const chunks: TextChunk[] = [];
  const accentFg = RGBA.fromHex(accentColor);
  const textFg = RGBA.fromHex(textColor);
  let lastIndex = 0;

  IMAGE_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      chunks.push({ __isChunk: true, text: text.slice(lastIndex, match.index), fg: textFg, attributes: 0 });
    }
    chunks.push({ __isChunk: true, text: match[0], fg: accentFg, attributes: 1 });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    chunks.push({ __isChunk: true, text: text.slice(lastIndex), fg: textFg, attributes: 0 });
  }
  return new StyledText(chunks);
}

interface UserEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
}

function UserEntryInner(
  { entry, colors }: UserEntryProps,
): React.ReactNode {
  const text = entry.userText ?? "";
  const queued = entry.userQueued ?? false;
  const hasTokens = IMAGE_TOKEN_PATTERN.test(text);
  IMAGE_TOKEN_PATTERN.lastIndex = 0;

  const styledContent = useMemo(
    () => hasTokens ? buildUserStyledText(text, colors.accent, colors.text) : undefined,
    [text, hasTokens, colors.accent, colors.text],
  );

  return (
    <box>
      <box height={1} />
      <box flexDirection="row">
        <box width={1} backgroundColor={colors.accent} />
        <box paddingLeft={1} paddingRight={1} flexGrow={1} backgroundColor={colors.userWash}>
          {styledContent
            ? <text content={styledContent} wrapMode="word" width="100%" />
            : <text fg={colors.text} content={text} wrapMode="word" width="100%" />
          }
          {queued ? <text fg={colors.orange} content=" [queued]" /> : null}
        </box>
      </box>
    </box>
  );
}

export const UserEntry = React.memo(
  UserEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
