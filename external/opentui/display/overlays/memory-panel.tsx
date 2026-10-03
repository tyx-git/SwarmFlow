/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import { MetricPanel } from "./metric-panel.js";
import { truncateToWidth } from "../utils/format.js";

interface MemoryPanelProps {
  lines: readonly string[];
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  onDismiss: () => void;
}

export function MemoryPanel({
  lines,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
}: MemoryPanelProps): React.ReactNode {
  const contentWidth = Math.max(20, terminalWidth - 8);
  const body = (
    <box flexDirection="column">
      {lines.map((line, index) => (
        <text key={`memory-line-${index}`} fg={theme.colors.text} content={truncateToWidth(line, contentWidth)} wrapMode="none" />
      ))}
    </box>
  );
  return (
    <MetricPanel
      title="[memory]"
      body={body}
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      verticalHalfOffset={5}
      onDismiss={onDismiss}
      inline
    />
  );
}
