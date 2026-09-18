/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import { ToastFrame } from "./toast-frame.js";

interface CopyToastProps {
  /** Body text, e.g. "Copied to clipboard". */
  message: string;
  theme: DisplayTheme;
}

/**
 * Transient toast shown after copy-on-select. Unlike the update/MCP toasts,
 * this one auto-dismisses — its ~2s lifecycle timer is owned by the app
 * (flashCopyToast). This component is pure presentation.
 */
export function CopyToast({ message, theme }: CopyToastProps): React.ReactNode {
  const { colors } = theme;
  return (
    <ToastFrame title=" Copied " titleColor={colors.accent} borderColor={colors.accent} theme={theme}>
      <text fg={colors.text} content={message} />
    </ToastFrame>
  );
}
