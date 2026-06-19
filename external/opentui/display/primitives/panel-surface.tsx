/** @jsxImportSource @opentui/react */

import React from "react";

import type { DisplayThemeColorTokens, DisplayThemeSpacingTokens } from "../theme/index.js";

interface PanelSurfaceProps {
  colors: DisplayThemeColorTokens;
  spacing?: DisplayThemeSpacingTokens;
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  flexDirection?: "row" | "column";
  flexShrink?: number;
  flexGrow?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  border?: boolean;
  children: React.ReactNode;
}

export function PanelSurface({
  colors,
  spacing,
  width = "100%",
  height,
  flexDirection = "column",
  flexShrink = 0,
  flexGrow,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  border = true,
  children,
}: PanelSurfaceProps): React.ReactNode {
  return (
    <box
      border={border}
      borderColor={border ? colors.border : undefined}
      width={width}
      height={height}
      flexDirection={flexDirection}
      flexShrink={flexShrink}
      flexGrow={flexGrow}
      paddingLeft={paddingLeft ?? spacing?.surfacePaddingX ?? 1}
      paddingRight={paddingRight ?? spacing?.surfacePaddingX ?? 1}
      paddingTop={paddingTop ?? spacing?.surfacePaddingY ?? 0}
      paddingBottom={paddingBottom ?? spacing?.surfacePaddingY ?? 0}
    >
      {children}
    </box>
  );
}
