/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import type { UiText } from "../../../../src/lib/ui-text.js";
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

export interface UsageStatsData {
  cumulativeInput: number;
  cumulativeCacheRead: number;
  cumulativeUncached: number;
  cumulativeOutput: number;
  sessionCount: number;
}

function cacheHitRate(data: UsageData): number {
  if (data.cumulativeInput <= 0) return 0;
  return Math.max(0, Math.min(1, data.cumulativeCacheRead / data.cumulativeInput));
}

function cacheHitRateColor(rate: number, colors: DisplayTheme["colors"]): string {
  if (rate >= 0.95) return colors.green;
  if (rate >= 0.5) return colors.yellow;
  return colors.red;
}

interface UsagePanelProps {
  /** null while the session-usage scan is still running. */
  data: UsageData | null;
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  onDismiss: () => void;
  inline?: boolean;
  uiText: UiText;
  page?: "usage" | "stats";
  statsData?: UsageStatsData | null;
}

/** 会话用量面板高度较大，垂直中线向上偏移 6 行。 */
const VERTICAL_HALF_OFFSET = 6;

function UsageBody({ data, colors, uiText }: { data: UsageData; colors: DisplayTheme["colors"]; uiText: UiText }): React.ReactNode {
  const ctx = data.contextUsed;
  const limit = data.contextLimit;
  const b = data.breakdown;
  const t = (key: string) => uiText.get(["Views", "usage", key]);
  const hitRate = cacheHitRate(data);
  const hitRateText = `${(hitRate * 100).toFixed(1)}%`;

  return (
    <box flexDirection="column">
      <MetricRow label={t("totalInput")} value={formatMetricNumber(data.cumulativeInput)} fg={colors.text} dim={colors.dim} />
      <MetricRow
        label={t("cacheHitRate")}
        value={hitRateText}
        fg={colors.text}
        dim={colors.dim}
        valueFg={cacheHitRateColor(hitRate, colors)}
      />
      <MetricRow label={t("totalOutput")} value={formatMetricNumber(data.cumulativeOutput)} fg={colors.text} dim={colors.dim} />
      <MetricRow
        label={t("context")}
        value={formatMetricNumber(ctx)}
        pct={formatSharePct(ctx, limit)}
        fg={colors.text}
        dim={colors.dim}
      />
      <MetricRow label={t("systemPrompt")} value={formatMetricNumber(b.systemPrompt)} pct={formatSharePct(b.systemPrompt, limit)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label={t("tools")} value={formatMetricNumber(b.tools)} pct={formatSharePct(b.tools, limit)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label={t("agentsMd")} value={formatMetricNumber(b.agentsMd)} pct={formatSharePct(b.agentsMd, limit)} fg={colors.text} dim={colors.dim} indent />
      {b.skills > 0 ? (
        <MetricRow label={t("skills")} value={formatMetricNumber(b.skills)} pct={formatSharePct(b.skills, limit)} fg={colors.text} dim={colors.dim} indent />
      ) : null}
      <MetricRow label={t("messages")} value={formatMetricNumber(b.messages)} pct={formatSharePct(b.messages, limit)} fg={colors.text} dim={colors.dim} indent />
    </box>
  );
}

function StatsBody({ data, colors }: { data: UsageStatsData; colors: DisplayTheme["colors"] }): React.ReactNode {
  return (
    <box flexDirection="column">
      <MetricRow label="Sessions" value={String(data.sessionCount)} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Total input" value={formatMetricNumber(data.cumulativeInput)} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Cached" value={formatMetricNumber(data.cumulativeCacheRead)} pct={formatSharePct(data.cumulativeCacheRead, data.cumulativeInput)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label="Uncached" value={formatMetricNumber(data.cumulativeUncached)} pct={formatSharePct(data.cumulativeUncached, data.cumulativeInput)} fg={colors.text} dim={colors.dim} indent />
      <MetricRow label="Total output" value={formatMetricNumber(data.cumulativeOutput)} fg={colors.text} dim={colors.dim} />
    </box>
  );
}

export function UsagePanel({
  data,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
  inline = false,
  uiText,
  page = "usage",
  statsData = null,
}: UsagePanelProps): React.ReactNode {
  const body = page === "stats"
    ? statsData === null
      ? <text fg={theme.colors.dim} content={uiText.get(["Views", "usage", "calculating"])} />
      : <StatsBody data={statsData} colors={theme.colors} />
    : data === null
      ? <text fg={theme.colors.dim} content={uiText.get(["Views", "usage", "calculating"])} />
      : <UsageBody data={data} colors={theme.colors} uiText={uiText} />;

  return (
    <MetricPanel
      title="[usage]"
      body={body}
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      verticalHalfOffset={VERTICAL_HALF_OFFSET}
      onDismiss={onDismiss}
      inline={inline}
      dismissLabel={uiText.get(["Views", "usage", "dismiss"])}
    />
  );
}
