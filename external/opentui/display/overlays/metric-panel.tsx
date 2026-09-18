/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";
import type { DisplayTheme } from "../theme/index.js";

/**
 * 统计类浮层（会话用量 / 全时段统计）的共享外壳。
 *
 * 两个面板的差别只在标题、正文行与垂直偏移，其余（数字格式化、行布局、
 * 居中定位、边框、Esc 关闭脚注）原先是两份逐行重复的实现。
 */

const ATTRS_BOLD = createTextAttributes({ bold: true });

const COL_LABEL = 18;
const COL_NUM = 10;
const COL_PCT = 9;
const ROW_WIDTH = COL_LABEL + COL_NUM + COL_PCT;
/** 行宽 + 左右 padding(3+1) + 边框(2)。 */
const PANEL_WIDTH = ROW_WIDTH + 6;

/** 紧凑数字格式：1234 → "1.2k"，跨 k/M/B/T 五档。 */
export function formatMetricNumber(value: number): string {
  const n = value ?? 0;
  if (n === 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n < 1_000_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  return `${(n / 1_000_000_000_000).toFixed(1)}T`;
}

export interface MetricRowProps {
  label: string;
  value: string;
  /** 右侧括号百分比，如 "(12.3%)"。 */
  pct?: string;
  fg: string;
  dim: string;
  /** 子项：缩进两格并弱化，不带加粗。 */
  indent?: boolean;
}

export function MetricRow({ label, value, pct, fg, dim, indent }: MetricRowProps): React.ReactNode {
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

/** 相对上下文总量的百分比串；总量为 0 时返回 "(0.0%)"。 */
export function formatSharePct(part: number, total: number): string {
  return total > 0 ? `(${((part / total) * 100).toFixed(1)}%)` : "(0.0%)";
}

interface CenteredGeometry {
  width: number;
  left: number;
  top: number;
}

/** 依据终端尺寸计算居中浮层的位置；宽度受终端宽度约束。 */
export function centeredPanelGeometry(
  terminalWidth: number,
  terminalHeight: number,
  verticalHalfOffset: number,
): CenteredGeometry {
  const width = Math.min(PANEL_WIDTH, terminalWidth - 4);
  const left = Math.max(0, Math.floor((terminalWidth - width) / 2));
  const top = Math.max(1, Math.floor(terminalHeight / 2) - verticalHalfOffset);
  return { width, left, top };
}

export interface MetricPanelProps {
  title: string;
  body: React.ReactNode;
  theme: DisplayTheme;
  terminalWidth: number;
  terminalHeight: number;
  /** 从终端垂直中线向上偏移的行数，用于让不同高度的面板视觉居中。 */
  verticalHalfOffset: number;
  onDismiss: () => void;
}

export function MetricPanel({
  title,
  body,
  theme,
  terminalWidth,
  terminalHeight,
  verticalHalfOffset,
  onDismiss,
}: MetricPanelProps): React.ReactNode {
  const { colors } = theme;
  const { width, left, top } = centeredPanelGeometry(terminalWidth, terminalHeight, verticalHalfOffset);

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
        title={title}
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
