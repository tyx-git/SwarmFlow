/** @jsxImportSource @opentui/react */

import React from "react";
import { RGBA, createTextAttributes } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { DisplayThemeColorTokens } from "../theme/types.js";

const BACKDROP_COLOR = RGBA.fromInts(0, 0, 0, 150);

export interface CenteredModalProps {
  visible: boolean;
  title: string;
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
  colors: DisplayThemeColorTokens;
  panelBg?: string;
  children: React.ReactNode;
}

/**
 * Centered modal overlay — full-screen dimmed RGBA backdrop + background-only panel.
 * Follows OpenCode dialog pattern: no border, solid backgroundColor, generous padding.
 */
export function CenteredModal({
  visible,
  title,
  width,
  height,
  terminalWidth,
  terminalHeight,
  colors,
  panelBg,
  children,
}: CenteredModalProps): React.ReactNode {
  if (!visible) return null;

  const effectiveWidth = Math.min(width, terminalWidth - 2);
  const effectiveHeight = Math.min(height, terminalHeight - 4);
  const bg = panelBg ?? colors.userBg ?? "#322e3e";

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={terminalWidth}
      height={terminalHeight}
      backgroundColor={BACKDROP_COLOR}
      alignItems="center"
      paddingTop={Math.max(1, Math.floor(terminalHeight / 4))}
      zIndex={99}
    >
      <box
        width={effectiveWidth}
        maxWidth={terminalWidth - 2}
        height={effectiveHeight}
        backgroundColor={bg}
        flexDirection="column"
        paddingTop={1}
      >
        {/* Header: title */}
        <box width="100%" paddingLeft={2} paddingRight={2}>
          <text fg={colors.text} attributes={ATTRS_BOLD} content={title} />
        </box>

        {/* Content — scrollable */}
        <scrollbox flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
          {children}
        </scrollbox>
      </box>
    </box>
  );
}
