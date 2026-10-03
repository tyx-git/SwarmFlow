/** @jsxImportSource @opentui/react */

import React from "react";
import { getCommonColors } from "../../display/theme/color-config.js";
import type { PresentationEntry } from "../../presentation/types.js";

const COMMON_COLORS = getCommonColors();

export function CommandEchoEntry({ entry }: { entry: PresentationEntry }): React.ReactNode {
  const color = entry.commandEchoTone === "worked"
    ? COMMON_COLORS.workedStatus
    : COMMON_COLORS.commandSwitchEchoText;
  return (
    <box width="100%" flexShrink={0}>
      <text fg={color} content={entry.commandEchoText ?? ""} wrapMode="word" />
    </box>
  );
}
