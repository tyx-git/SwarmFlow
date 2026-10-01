/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });

/** Add the shared error marker without duplicating it for already-formatted text. */
export function formatErrorMessage(text: string): string {
  const normalized = text.trimStart();
  if (normalized.startsWith("■")) return normalized;
  if (normalized.startsWith("[!]")) return `■${normalized.slice(3).trimStart()}`;
  return `■ ${normalized}`;
}

/** Shared TUI error presentation: marker, bold emphasis, and the theme red. */
export function ErrorMessage({ text, colors }: { text: string; colors: { red: string } }): React.ReactNode {
  return <text fg={colors.red} attributes={ATTRS_BOLD} content={formatErrorMessage(text)} />;
}
