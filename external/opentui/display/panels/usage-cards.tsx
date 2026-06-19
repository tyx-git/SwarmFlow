/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

import { formatResetRemaining, type UsageSnapshot } from "../../../../src/providers/usage.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import {
  readOAuthAccessToken,
  getTokenExpiry,
} from "../../../../src/auth/openai-oauth.js";
import type { DisplayTheme } from "../theme/index.js";
import {
  formatCompactTokens,
  formatExpiryRemaining,
  formatUsagePercent,
} from "../utils/format.js";

export function ContextUsageCard(
  {
    contextTokens,
    contextLimit,
    cacheReadTokens,
    theme,
  }: {
    contextTokens: number;
    contextLimit?: number;
    cacheReadTokens?: number;
    theme: DisplayTheme;
  },
): React.ReactNode {
  const percentText = formatUsagePercent(contextTokens, contextLimit);
  const barWidth = 20;
  const limit = contextLimit && contextLimit > 0 ? contextLimit : 1;
  const ratio = contextTokens / limit;
  const filledBlocks = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  const emptyBlocks = Math.max(0, barWidth - filledBlocks);
  const barColor = ratio > 0.8
    ? theme.colors.red
    : ratio > 0.5
      ? theme.colors.orange
      : theme.colors.accent;

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <text fg={theme.colors.dim} attributes={ATTRS_BOLD} content="CONTEXT" />
      <box flexDirection="row">
        {filledBlocks > 0 ? <text fg={barColor} content={"━".repeat(filledBlocks)} /> : null}
        {emptyBlocks > 0 ? <text fg={theme.colors.border} content={"─".repeat(emptyBlocks)} /> : null}
        <text fg={theme.colors.text} content={` ${percentText}`} />
      </box>
      <box flexDirection="row">
        <text fg={theme.colors.text} content={formatCompactTokens(contextTokens)} />
        <text fg={theme.colors.muted} content={`/${contextLimit ? formatCompactTokens(contextLimit) : "?"}`} />
        {(cacheReadTokens ?? 0) > 0 ? (
          <text fg={theme.colors.muted} content={` (${formatCompactTokens(cacheReadTokens)} hit)`} />
        ) : null}
      </box>
    </box>
  );
}

export function CodexUsageCard(
  {
    snapshot,
    theme,
  }: {
    snapshot: UsageSnapshot | null;
    theme: DisplayTheme;
  },
): React.ReactNode {
  if (!snapshot || snapshot.windows.length === 0 || snapshot.error) return null;

  const now = Date.now();
  const token = readOAuthAccessToken();
  const expiry = token ? getTokenExpiry(token) : null;

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <text fg={theme.colors.dim} attributes={ATTRS_BOLD} content="CODEX USAGE" />
      {snapshot.windows.map((window, index) => {
        const pctStr = window.remainPercent.toFixed(0).padStart(3);
        const reset = formatResetRemaining(window.resetAt, now);
        const resetSuffix = reset ? `  in ${reset}` : "";
        return (
          <text
            key={`codex-window-${index}`}
            fg={theme.colors.muted}
            content={`${window.label.padEnd(3)}: ${pctStr}% left${resetSuffix}`}
          />
        );
      })}
      {expiry ? (
        <text fg={theme.colors.muted} content={`Expires in ${formatExpiryRemaining(expiry)}`} />
      ) : null}
    </box>
  );
}
