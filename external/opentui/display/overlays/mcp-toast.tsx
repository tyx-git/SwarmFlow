/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import { ToastFrame } from "./toast-frame.js";
import { ErrorMessage } from "../primitives/error-message.js";

export interface McpFailure {
  name: string;
  error?: string;
}

interface McpToastProps {
  failures: McpFailure[];
  theme: DisplayTheme;
}

// The toast does not auto-dismiss: an MCP connection failure stays visible
// until it clears on its own (the server recovers — handled by onMcpStatus) or
// the user dismisses it manually (Ctrl+L). Both paths live at the app level.
export function McpToast({ failures, theme }: McpToastProps): React.ReactNode {
  const { colors } = theme;

  const lines: string[] = [];
  for (const f of failures.slice(0, 3)) {
    const err = f.error ? `: ${f.error.slice(0, 40)}` : "";
    lines.push(`${f.name}${err}`);
  }
  if (failures.length > 3) {
    lines.push(`… and ${failures.length - 3} more`);
  }

  return (
    <ToastFrame
      title=" MCP "
      titleColor={colors.errorStatus ?? colors.accent}
      borderColor={colors.errorStatus ?? colors.dim}
      theme={theme}
    >
      <ErrorMessage
        text={`${failures.length} server${failures.length > 1 ? "s" : ""} failed to connect:`}
        colors={colors}
      />
      {lines.map((line, i) => (
        <ErrorMessage key={i} text={line} colors={colors} />
      ))}
    </ToastFrame>
  );
}
