/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";
import { MetricPanel, MetricRow, formatMetricNumber } from "./metric-panel.js";

export interface SessionStatusData {
  model: string;
  provider: string;
  permission: string;
  openTasks: number;
  totalTasks: number;
  mcpServers: number;
  failedMcpServers: number;
  enabledSkills: number;
  totalSkills: number;
  lastTokens: number;
  cacheReadTokens: number;
}

interface SessionStatusPanelProps {
  data: SessionStatusData;
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  onDismiss: () => void;
  inline?: boolean;
}

function StatusBody({ data, colors }: { data: SessionStatusData; colors: DisplayTheme["colors"] }): React.ReactNode {
  return (
    <box flexDirection="column">
      <MetricRow label="Model" value={data.model} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Provider" value={data.provider} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Permission" value={data.permission} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Tasks" value={`${data.openTasks}/${data.totalTasks} open`} fg={colors.text} dim={colors.dim} />
      <MetricRow
        label="MCP"
        value={`${data.mcpServers}${data.failedMcpServers > 0 ? ` (${data.failedMcpServers} failed)` : ""}`}
        fg={colors.text}
        dim={colors.dim}
        valueFg={data.failedMcpServers > 0 ? colors.red : colors.text}
      />
      <MetricRow label="Skills" value={`${data.enabledSkills}/${data.totalSkills} enabled`} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Last tokens" value={formatMetricNumber(data.lastTokens)} fg={colors.text} dim={colors.dim} />
      <MetricRow label="Cache read" value={formatMetricNumber(data.cacheReadTokens)} fg={colors.text} dim={colors.dim} />
    </box>
  );
}

export function SessionStatusPanel({
  data,
  theme,
  terminalWidth,
  terminalHeight,
  onDismiss,
  inline = false,
}: SessionStatusPanelProps): React.ReactNode {
  return (
    <MetricPanel
      title="[status]"
      body={<StatusBody data={data} colors={theme.colors} />}
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      verticalHalfOffset={5}
      onDismiss={onDismiss}
      inline={inline}
    />
  );
}
