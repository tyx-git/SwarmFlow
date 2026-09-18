/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import {
  formatMetricNumber,
  formatSharePct,
  MetricPanel,
  MetricRow,
} from "./metric-panel.js";

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

/** 全时段统计面板高度较小，垂直中线向上偏移 5 行。 */
const VERTICAL_HALF_OFFSET = 5;

function StatBody({ data, colors }: { data: StatData; colors: DisplayTheme["colors"] }): React.ReactNode {
  return (
    <box flexDirection="column">
      <MetricRow label="Sessions" value={String(data.sessionCount)} fg={colors.text} dim={colors.dim} />
      <box height={1} />
      <MetricRow label="Total Input" value={formatMetricNumber(data.cumulativeInput)} fg={colors.text} dim={colors.dim} />
      <MetricRow
        label="Cached"
        value={formatMetricNumber(data.cumulativeCacheRead)}
        pct={formatSharePct(data.cumulativeCacheRead, data.cumulativeInput)}
        fg={colors.text}
        dim={colors.dim}
        indent
      />
      <MetricRow
        label="Uncached"
        value={formatMetricNumber(data.cumulativeUncached)}
        pct={formatSharePct(data.cumulativeUncached, data.cumulativeInput)}
        fg={colors.text}
        dim={colors.dim}
        indent
      />
      <MetricRow label="Total Output" value={formatMetricNumber(data.cumulativeOutput)} fg={colors.text} dim={colors.dim} />
    </box>
  );
}

export function StatPanel({
  data,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
}: StatPanelProps): React.ReactNode {
  const body = data === null
    ? <text fg={theme.colors.dim} content="Scanning all sessions …" />
    : <StatBody data={data} colors={theme.colors} />;

  return (
    <MetricPanel
      title=" All-Time Stats "
      body={body}
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      verticalHalfOffset={VERTICAL_HALF_OFFSET}
      onDismiss={onDismiss}
    />
  );
}
