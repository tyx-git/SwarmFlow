/** @jsxImportSource @opentui/react */

import React from "react";
import type { DisplayTheme } from "../theme/index.js";

/** One colored/clickable segment of a toast's bottom-right footer overlay. */
export interface ToastFooterSegment {
  text: string;
  /** Defaults to the theme text color. */
  color?: string;
  /** When set, the segment becomes mouse-clickable. */
  onClick?: () => void;
}

export interface ToastFrameProps {
  /** Left-aligned title rendered on the top border. */
  title: string;
  titleColor?: string;
  borderColor?: string;
  /** Box width in columns; defaults to 100% (fills the surrounding ToastStack). */
  width?: number | `${number}%`;
  /** Optional segments overlaid on the bottom border, right-aligned. */
  footer?: ToastFooterSegment[];
  theme: DisplayTheme;
  children: React.ReactNode;
}

/**
 * Shared visual shell for the top-right corner toasts (update / MCP / copy).
 * Pure presentation — positioning and vertical stacking are owned by
 * <ToastStack>, so this component never sets its own absolute position.
 *
 * The footer is an absolutely-positioned overlay on the bottom border: the
 * relative wrapper is the containing block, `bottom={0}` lands on the border
 * row, and `fillTransparentBackground` clears the border chars so the text
 * renders on top (the original UpdateToast "Ctrl+L dismiss" affordance).
 */
export function ToastFrame({
  title,
  titleColor,
  borderColor,
  width = "100%",
  footer,
  theme,
  children,
}: ToastFrameProps): React.ReactNode {
  const { colors } = theme;
  return (
    <box width={width} flexDirection="column">
      <box
        border={true}
        borderStyle="rounded"
        borderColor={borderColor ?? colors.dim}
        title={title}
        titleColor={titleColor ?? colors.accent}
        fillTransparentBackground={true}
        paddingLeft={1}
        paddingRight={1}
        width="100%"
      >
        {children}
      </box>
      {footer && footer.length > 0 ? (
        <box position="absolute" bottom={0} right={1} flexDirection="row" fillTransparentBackground={true}>
          {footer.map((seg, i) => (
            <text
              key={i}
              fg={seg.color ?? colors.text}
              content={seg.text}
              onMouseDown={
                seg.onClick
                  ? (e: any) => {
                      e.stopPropagation();
                      e.preventDefault();
                      seg.onClick!();
                    }
                  : undefined
              }
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}

const STACK_WIDTH = 44;

export interface ToastStackProps {
  terminalWidth: number;
  children: React.ReactNode;
}

/**
 * Absolutely-positioned top-right container that stacks toasts vertically.
 * Toasts render in child order and reflow upward when one unmounts. Owning
 * positioning here (instead of per-toast) is what keeps the update / MCP /
 * copy toasts from colliding at the same top-right coordinate.
 */
export function ToastStack({ terminalWidth, children }: ToastStackProps): React.ReactNode {
  return (
    <box
      position="absolute"
      top={2}
      left={Math.max(0, terminalWidth - STACK_WIDTH - 3)}
      width={STACK_WIDTH}
      zIndex={50}
      flexDirection="column"
      gap={1}
    >
      {children}
    </box>
  );
}
