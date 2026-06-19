/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { StyledText, RGBA, createTextAttributes, type TextChunk } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import type { DisplayTheme } from "../../display/theme/index.js";
import { getSystemEntryColor } from "../../display/entries/entry-variants.js";

const NO_REPLY_LABEL = "NO REPLY";

function buildGradientLabel(label: string, gradient: readonly string[]): StyledText {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < label.length; i++) {
    const colorIdx = Math.floor((i / Math.max(1, label.length - 1)) * (gradient.length - 1));
    const fg = RGBA.fromHex(gradient[colorIdx]);
    chunks.push({ __isChunk: true, text: label[i], fg });
  }
  return new StyledText(chunks);
}

interface SystemEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  theme: DisplayTheme;
}

function SystemEntryInner(
  { entry, colors, theme }: SystemEntryProps,
): React.ReactNode {
  const text = entry.systemText ?? "";
  const severity = entry.systemSeverity ?? "info";
  const fg = getSystemEntryColor(severity, theme);

  if (severity === "no_reply") {
    const fullGradient = theme.branding.logoGradient;
    // Use brighter portion of gradient — skip the darkest tail
    const gradient = useMemo(() => fullGradient.slice(0, 5), [fullGradient]);
    const gradientLabel = useMemo(
      () => buildGradientLabel(NO_REPLY_LABEL, gradient),
      [gradient],
    );
    // Strip any prefix like "[No reply] " from text to get the message part
    const message = text.replace(/^\[.*?\]\s*/, "");
    return (
      <box paddingTop={1} width="100%" flexDirection="row">
        <text content={gradientLabel} attributes={ATTRS_BOLD} />
        <text fg={colors.text} content={`  ${message}`} />
      </box>
    );
  }

  switch (severity) {
    case "error":
      return (
        <box paddingTop={1} width="100%">
          <text fg={fg} attributes={ATTRS_BOLD} content={`[!] ${text}`} />
        </box>
      );

    case "interrupted":
      return (
        <box width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "sub_agent":
      return (
        <box flexDirection="column" width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "compact":
      return (
        <box paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    default:
      return (
        <box paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );
  }
}

export const SystemEntry = React.memo(
  SystemEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors && prev.theme === next.theme,
);
