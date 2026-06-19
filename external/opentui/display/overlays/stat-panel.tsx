/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";
import type { DisplayTheme } from "../theme/index.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });

export interface StatData {
  cumulativeInput: number;
  cumulativeCacheRead: number;
  cumulativeUncached: number;
  cumulativeOutput: number;
  sessionCount: number;
}

interface StatPanelProps {
  data: StatData | null;
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  onDismiss: () => void;
}

function fmtNum(n: number): string {
  if (n === 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n < 1_000_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  return `${(n / 1_000_000_000_000).toFixed(1)}T`;
}

const COL_LABEL = 18;
const COL_NUM = 10;
const COL_PCT = 9;
const ROW_WIDTH = COL_LABEL + COL_NUM + COL_PCT;

function Row({ label, value, pct, fg, dim, indent }: {
  label: string;
  value: string;
  pct?: string;
  fg: string;
  dim: string;
  indent?: boolean;
}): React.ReactNode {
  const prefix = indent ? "  " : "";
  const paddedLabel = `${prefix}${label}`.padEnd(COL_LABEL);
  const paddedValue = value.padStart(COL_NUM);
  const paddedPct = pct ? `${pct}`.padStart(COL_PCT) : "".padEnd(COL_PCT);
  return (
    <box flexDirection="row" width={ROW_WIDTH}>
      <text fg={indent ? dim : fg} attributes={indent ? undefined : ATTRS_BOLD} content={paddedLabel} />
      <text fg={fg} content={paddedValue} />
      <text fg={dim} content={paddedPct} />
    </box>
  );
}

const PANEL_WIDTH = ROW_WIDTH + 6;

export function StatPanel({
  data,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
}: StatPanelProps): React.ReactNode {
  const { colors } = theme;

  const width = Math.min(PANEL_WIDTH, terminalWidth - 4);
  const left = Math.max(0, Math.floor((terminalWidth - width) / 2));
  const top = Math.max(1, Math.floor(terminalHeight / 2) - 5);

  let body: React.ReactNode;
  if (data === null) {
    body = <text fg={colors.dim} content="Scanning all sessions …" />;
  } else {
    const cachedPct = data.cumulativeInput > 0
      ? `(${((data.cumulativeCacheRead / data.cumulativeInput) * 100).toFixed(1)}%)`
      : "(0.0%)";
    const uncachedPct = data.cumulativeInput > 0
      ? `(${((data.cumulativeUncached / data.cumulativeInput) * 100).toFixed(1)}%)`
      : "(0.0%)";

    body = (
      <box flexDirection="column">
        <Row label="Sessions" value={String(data.sessionCount)} fg={colors.text} dim={colors.dim} />
        <box height={1} />
        <Row label="Total Input" value={fmtNum(data.cumulativeInput)} fg={colors.text} dim={colors.dim} />
        <Row label="Cached" value={fmtNum(data.cumulativeCacheRead)} pct={cachedPct} fg={colors.text} dim={colors.dim} indent />
        <Row label="Uncached" value={fmtNum(data.cumulativeUncached)} pct={uncachedPct} fg={colors.text} dim={colors.dim} indent />
        <Row label="Total Output" value={fmtNum(data.cumulativeOutput)} fg={colors.text} dim={colors.dim} />
      </box>
    );
  }

  return (
    <box
      position="absolute"
      top={top}
      left={left}
      width={width}
      zIndex={98}
      flexDirection="column"
    >
      <box
        border={true}
        borderStyle="rounded"
        borderColor={colors.dim}
        title=" All-Time Stats "
        titleColor={colors.accent}
        fillTransparentBackground={true}
        paddingLeft={3}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        width="100%"
      >
        {body}
      </box>
      <box position="absolute" bottom={0} right={1} flexDirection="row" fillTransparentBackground={true}>
        <text fg={colors.text} content=" Esc " />
        <text
          fg={colors.accent}
          content="dismiss "
          onMouseDown={(e: any) => {
            e.stopPropagation();
            e.preventDefault();
            onDismiss();
          }}
        />
      </box>
    </box>
  );
}
