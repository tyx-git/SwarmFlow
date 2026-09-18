/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import {
  formatMetricNumber,
  formatSharePct,
  MetricPanel,
  MetricRow,
} from "./metric-panel.js";

export interface UsageData {
  cumulativeInput: number;
  cumulativeCacheRead: number;
  cumulativeUncached: number;
  cumulativeOutput: number;
  contextUsed: number;
  contextLimit: number;
  breakdown: {
    systemPrompt: number;
    tools: number;
    agentsMd: number;
    skills: number;
    messages: number;
  };
}

interface UsagePanelProps {
  /** null while the session-usage scan is still running. */
  data: UsageData | null;
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  onDismiss: () => void;
}

/** 会话用量面板高度较大，垂直中线向上偏移 6 行。 */
const VERTICAL_HALF_OFFSET = 6;

function UsageBody({ data, colors }: { data: UsageData; colors: DisplayTheme["colors"] }): React.ReactNode {
  const ctx = data.contextUsed;
  const b = data.breakdown;

  return (
    <box flexDirection="column">
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
      <box height={1} />
      <MetricRow label="Context" value={formatMetricNumber(ctx)} fg={colors.text} dim={colors.dim} />
      <MetricRow label="System Prompt" value={formatMetricNumber(b.systemPrompt)} pct={formatSharePct(b.systemPrompt, ctx)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label="Tools" value={formatMetricNumber(b.tools)} pct={formatSharePct(b.tools, ctx)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label="AGENTS.md" value={formatMetricNumber(b.agentsMd)} pct={formatSharePct(b.agentsMd, ctx)} fg={colors.text} dim={colors.dim} indent />
      {b.skills > 0 ? (
        <MetricRow label="Skills" value={formatMetricNumber(b.skills)} pct={formatSharePct(b.skills, ctx)} fg={colors.text} dim={colors.dim} indent />
      ) : null}
      <MetricRow label="Messages" value={formatMetricNumber(b.messages)} pct={formatSharePct(b.messages, ctx)} fg={colors.text} dim={colors.dim} indent />
    </box>
  );
}

export function UsagePanel({
  data,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
}: UsagePanelProps): React.ReactNode {
  const body = data === null
    ? <text fg={theme.colors.dim} content="Calculating session usage …" />
    : <UsageBody data={data} colors={theme.colors} />;

  return (
    <MetricPanel
      title=" Session Usage "
      body={body}
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      verticalHalfOffset={VERTICAL_HALF_OFFSET}
      onDismiss={onDismiss}
    />
  );
}
