/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

import { stringWidth } from "../../forked/core/platform/runtime.js";
import { wrapToLines } from "../../display/utils/format.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

/** Tips 整行顶格：它是回合级说明，不跟随工具体 `└` 的缩进。 */
export const TIPS_PREFIX = "└ Tips: ";
export const TIPS_MAX_CHARS = 600;
export const TIPS_MAX_LINES = 4;

// 终端单元格定宽、没有字号，标签只能靠粗体和斜体正文拉开层级。
const ATTRS_LABEL = createTextAttributes({ bold: true });
const ATTRS_ITALIC = createTextAttributes({ italic: true });
const PREFIX_WIDTH = stringWidth(TIPS_PREFIX);

interface TipsEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
}

function normalizeTipsText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function capTipsChars(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= TIPS_MAX_CHARS) return value;
  return `${chars.slice(0, TIPS_MAX_CHARS).join("")}…`;
}

export function TipsEntry({ entry, colors, contentWidth }: TipsEntryProps): React.ReactNode {
  const text = capTipsChars(normalizeTipsText(entry.tipsText ?? ""));
  if (!text) return null;

  const bodyWidth = Math.max(1, contentWidth - PREFIX_WIDTH);
  const { lines } = wrapToLines(text, bodyWidth, TIPS_MAX_LINES);
  if (lines.length === 0) return null;

  return (
    <box flexDirection="row" width="100%" flexShrink={0}>
      <text
        fg={colors.tips}
        attributes={ATTRS_LABEL}
        content={TIPS_PREFIX}
        flexShrink={0}
      />
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        {lines.map((line, index) => (
          <text
            key={index}
            fg={colors.tips}
            attributes={ATTRS_ITALIC}
            content={line}
            wrapMode="none"
          />
        ))}
      </box>
    </box>
  );
}
