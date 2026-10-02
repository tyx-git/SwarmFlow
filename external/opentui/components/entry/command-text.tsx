/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";
import { RGBA } from "@opentui/core";

import type { ConversationPalette } from "../conversation-types.js";
import {
  buildCommandStyledText,
  type SyntaxTextMode,
} from "../syntax-highlight-utils.js";

interface CommandTextProps {
  text: string;
  colors: ConversationPalette;
  mode: SyntaxTextMode;
  language?: string;
  fallbackColor?: string;
  wrapMode?: "none" | "char" | "word";
  truncate?: boolean;
  flexGrow?: number;
  flexShrink?: number;
}

export function CommandText({
  text,
  colors,
  mode,
  language,
  fallbackColor,
  wrapMode = "char",
  truncate,
  flexGrow,
  flexShrink,
}: CommandTextProps): React.ReactNode {
  const content = useMemo(
    () => buildCommandStyledText(text, {
      mode,
      language,
      fallbackFg: RGBA.fromHex(fallbackColor ?? colors.toolResultBody),
      pathFg: RGBA.fromHex(colors.statusSession),
      lineFg: RGBA.fromHex(colors.orange),
      metadataFg: RGBA.fromHex(colors.dim),
    }),
    [text, colors, mode, language, fallbackColor],
  );

  return (
    <text
      content={content}
      wrapMode={wrapMode}
      truncate={truncate}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
    />
  );
}
