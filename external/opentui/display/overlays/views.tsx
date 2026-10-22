/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable } from "@opentui/core";
import type { CommandPickerState } from "../../../../src/ui/command-picker.js";
import {
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  isCommandPickerActive,
  isCommandPickerCustomInputOption,
} from "../../../../src/ui/command-picker.js";
import type { DisplayTheme } from "../theme/index.js";
import { createUiText, type UiLanguage } from "../../../../src/ui/text.js";
import type {
  CommandOverlayState,
  OAuthOverlayState,
  PromptSecretState,
  PromptSelectState,
} from "../types.js";
import { stringWidth } from "../../forked/core/platform/runtime.js";
import { truncateToWidth } from "../utils/format.js";
import { PanelSurface } from "../primitives/panel-surface.js";
import { SelectableRow } from "../primitives/selectable-row.js";
import { ErrorMessage } from "../primitives/error-message.js";
import { MAX_COMMAND_LIST_VISIBLE } from "../layout/metrics.js";

interface OverlayFrameProps {
  theme: DisplayTheme;
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  children: React.ReactNode;
}

function OverlayFrame({ theme, width = "100%", height, children }: OverlayFrameProps): React.ReactNode {
  return (
    <PanelSurface
      colors={theme.colors}
      spacing={theme.spacing}
      width={width}
      height={height}
      flexDirection="column"
      flexShrink={0}
      border={false}
    >
      {children}
    </PanelSurface>
  );
}

type SemanticColor = "success" | "error" | "muted";

interface OverlayOptionRowProps {
  theme: DisplayTheme;
  label: string;
  labelPrefix?: string;
  labelParts?: Array<{ text: string; color?: SemanticColor }>;
  detail?: string;
  detailColor?: SemanticColor;
  /** Fixed column width for detail text (for cross-row alignment). */
  detailColumnWidth?: number;
  /** Fixed column width for an optional left label prefix. */
  labelPrefixColumnWidth?: number;
  selected: boolean;
  disabled?: boolean;
  width: number;
  onPress?: () => void;
}

const SEMANTIC_COLOR_MAP: Record<string, (t: DisplayTheme) => string> = {
  success: (t) => t.colors.green,
  error: (t) => t.colors.red,
  muted: (t) => t.colors.muted,
};

function OverlayOptionRow({
  theme,
  label,
  labelPrefix,
  labelParts,
  detail,
  detailColor,
  detailColumnWidth,
  labelPrefixColumnWidth,
  selected,
  disabled = false,
  width,
  onPress,
}: OverlayOptionRowProps): React.ReactNode {
  const isSelected = selected && !disabled;
  const fg = disabled ? theme.colors.muted : isSelected ? theme.colors.accent : theme.colors.dim;
  const prefix = isSelected ? "❯ " : "  ";

  // Three-column rows (used by the skills picker): name on the left, a
  // flexible description in the middle, and the enable state on the right.
  // The description is truncated against the actual picker width.
  if (labelPrefix !== undefined && detail !== undefined && detailColumnWidth) {
    const gapWidth = 1;
    const prefixWidth = Math.max(
      stringWidth(`${prefix}${labelPrefix}`),
      labelPrefixColumnWidth ?? 0,
    );
    const middleWidth = Math.max(1, width - prefixWidth - gapWidth * 2 - detailColumnWidth);
    const detailFg = detailColor
      ? SEMANTIC_COLOR_MAP[detailColor]?.(theme) ?? fg
      : fg;

    return (
      <SelectableRow
        hoverBackgroundColor={theme.colors.border}
        onPress={disabled ? undefined : onPress}
      >
        <box flexDirection="row" width="100%">
          <text
            fg={fg}
            content={truncateToWidth(`${prefix}${labelPrefix}`, prefixWidth)}
            width={prefixWidth}
            flexShrink={0}
            wrapMode="none"
            truncate
          />
          <box width={gapWidth} flexShrink={0} />
          <text
            fg={fg}
            content={truncateToWidth(label, middleWidth)}
            width={middleWidth}
            flexGrow={1}
            flexShrink={1}
            wrapMode="none"
            truncate
          />
          <box width={gapWidth} flexShrink={0} />
          <text
            fg={detailFg}
            content={truncateToWidth(detail, detailColumnWidth)}
            width={detailColumnWidth}
            flexShrink={0}
            wrapMode="none"
            truncate
          />
        </box>
      </SelectableRow>
    );
  }

  // Rich label: render as inline colored segments, no detail column
  if (labelParts && labelParts.length > 0) {
    return (
      <SelectableRow
        hoverBackgroundColor={theme.colors.border}
        onPress={disabled ? undefined : onPress}
      >
        <box flexDirection="row" width="100%">
          <text fg={fg} content={prefix} wrapMode="none" />
          {labelParts.map((part, i) => (
            <text
              key={i}
              fg={part.color ? (SEMANTIC_COLOR_MAP[part.color]?.(theme) ?? fg) : fg}
              content={part.text}
              wrapMode="none"
            />
          ))}
        </box>
      </SelectableRow>
    );
  }

  // Two-column layout: label left, detail right
  if (detail !== undefined && detailColumnWidth) {
    const gapWidth = 1;
    const labelWidth = Math.max(1, width - detailColumnWidth - gapWidth);
    const iconFg = detailColor
      ? SEMANTIC_COLOR_MAP[detailColor]?.(theme) ?? fg
      : undefined;
    const iconMatch = iconFg ? detail.match(/^([^\s]+)(\s.*)$/) : null;
    return (
      <SelectableRow
        hoverBackgroundColor={theme.colors.border}
        onPress={disabled ? undefined : onPress}
      >
        <box flexDirection="row" width="100%">
          <text
            fg={fg}
            content={truncateToWidth(`${prefix}${label}`, labelWidth)}
            width={labelWidth}
            flexShrink={0}
            wrapMode="none"
            truncate
          />
          <box width={gapWidth} flexShrink={0} />
          {iconMatch ? (
            <box flexDirection="row" width={detailColumnWidth} flexShrink={0}>
              <text fg={iconFg} content={iconMatch[1]} wrapMode="none" />
              <text fg={fg} content={truncateToWidth(iconMatch[2], detailColumnWidth - iconMatch[1].length)} wrapMode="none" truncate />
            </box>
          ) : (
            <text
              fg={fg}
              content={truncateToWidth(detail, detailColumnWidth)}
              width={detailColumnWidth}
              flexShrink={0}
              wrapMode="none"
              truncate
            />
          )}
        </box>
      </SelectableRow>
    );
  }
  return (
    <SelectableRow
      hoverBackgroundColor={theme.colors.border}
      onPress={disabled ? undefined : onPress}
    >
      <text
        fg={fg}
        content={truncateToWidth(`${prefix}${label}`, width)}
        width={width}
        wrapMode="none"
        truncate
      />
    </SelectableRow>
  );
}

export function CommandOverlayView(
  {
    overlay,
    theme,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    overlay: CommandOverlayState;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactNode {
  if (!overlay.visible || overlay.items.length === 0) return null;
  // Slash command completion should stay compact even on tall terminals.
  // File completion keeps the layout-derived limit because paths can be
  // numerous and the existing picker height is useful there.
  const visibleLimit = overlay.mode === "command"
    ? Math.min(maxVisible, MAX_COMMAND_LIST_VISIBLE)
    : maxVisible;
  const start = Math.max(0, Math.min(
    overlay.selected - Math.floor(visibleLimit / 2),
    Math.max(0, overlay.items.length - visibleLimit),
  ));
  const end = Math.min(overlay.items.length, start + visibleLimit);
  const visibleItems = overlay.items.slice(start, end);

  return (
    <OverlayFrame theme={theme} height={visibleItems.length}>
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`overlay-${actualIndex}`}
            theme={theme}
            label={item}
            selected={actualIndex === overlay.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
    </OverlayFrame>
  );
}

export function CommandPickerView(
  {
    picker: pickerProp,
    theme,
    contentWidth,
    maxVisible,
    language = "en",
    onItemClick,
    noteInputRef,
    noteValue,
    onNoteInput,
  }: {
    picker: CommandPickerState | null;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    language?: UiLanguage;
    onItemClick: (index: number) => void;
    noteInputRef?: React.RefObject<InputRenderable | null>;
    noteValue?: string;
    onNoteInput?: (value: string) => void;
  },
): React.ReactNode {
  if (!isCommandPickerActive(pickerProp)) return null;

  const picker = { ...pickerProp, maxVisible: Math.min(maxVisible, MAX_COMMAND_LIST_VISIBLE) };
  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);
  const inlineInputLines = (picker.noteEditing || picker.customInputMode) ? 2 : 0;
  const hintLine = picker.inputArea ? 0 : 1;
  const titleLine = 1;
  const pickerHeight = titleLine + visibleOptions.length + inlineInputLines + hintLine;
  const rootTitle = picker.title ?? picker.commandName;
  const title = path.length > 0
    ? `${rootTitle} › ${path.join(" › ")}`
    : rootTitle;
  const rowContentWidth = contentWidth;
  const modelPickerHasBranches = level.options.some((option) =>
    Array.isArray(option.children) && option.children.length > 0,
  );
  const pickerText = createUiText(language);
  const inlineTitle = picker.commandName === "/model"
    ? pickerText.get(["Views", "commandPicker", modelPickerHasBranches ? "selectProvider" : "selectModel"])
    : picker.commandName === "/agents"
      ? pickerText.get(["Views", "commandPicker", "selectRole"])
    : picker.commandName === "/skills"
      ? pickerText.get(["Views", "commandPicker", "skills"])
      : picker.title === pickerText.get(["Views", "commandPicker", "thinkingTitle"])
          ? pickerText.get(["Views", "commandPicker", "thinkingDepth"])
          : picker.inputArea && !title
            ? pickerText.get(["Views", "commandPicker", "select"])
            : title;

  // Compute max detail width for column alignment
  const hasAnyDetail = level.options.some(o => o.detail !== undefined);
  const detailColumnWidth = hasAnyDetail
    ? Math.max(...level.options.map(o => stringWidth(o.detail ?? "")))
    : 0;
  const hasAnyLabelPrefix = level.options.some(o => o.labelPrefix !== undefined);
  const labelPrefixColumnWidth = hasAnyLabelPrefix
    ? Math.max(...level.options.map(o => stringWidth(o.labelPrefix ?? "") + 2))
    : 0;

  const isOnCustomInputOption = isCommandPickerCustomInputOption(picker);
  const showTabHint = picker.allowNote && !isOnCustomInputOption;
  const hintText = picker.noteEditing || picker.customInputMode
    ? pickerText.get(["Views", "commandPicker", "confirmHint"])
    : showTabHint
      ? pickerText.get(["Views", "commandPicker", "navigateTabHint"])
      : pickerText.get(["Views", "commandPicker", "navigateHint"]);

  return (
    <OverlayFrame theme={theme} height={pickerHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(picker.inputArea ? inlineTitle : title, contentWidth)} />
      {visibleOptions.map((item, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`picker-${picker.stack.length}-${actualIndex}`}
            theme={theme}
            label={item.label}
            labelPrefix={item.labelPrefix}
            labelParts={item.labelParts}
            detail={item.detail}
            detailColor={item.detailColor}
            detailColumnWidth={detailColumnWidth}
            labelPrefixColumnWidth={labelPrefixColumnWidth}
            selected={actualIndex === level.selected}
            disabled={item.disabled}
            width={rowContentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      {(picker.noteEditing || picker.customInputMode) && (
        <box flexDirection="column">
          <text
            fg={theme.colors.accent}
            content={picker.customInputMode
              ? (picker.customInputLabel ?? pickerText.get(["Views", "commandPicker", "yourInstructions"]))
              : pickerText.get(["Views", "commandPicker", "instructions"])}
          />
          <input
            ref={(node) => { if (noteInputRef) (noteInputRef as React.MutableRefObject<InputRenderable | null>).current = node; }}
            value={noteValue ?? ""}
            focused={picker.noteEditing || picker.customInputMode}
            placeholder={picker.customInputMode
              ? (picker.customInputPlaceholder ?? pickerText.get(["Views", "commandPicker", "typeInstructions"]))
              : pickerText.get(["Views", "commandPicker", "reviewInstructions"])}
            textColor={theme.colors.text}
            focusedTextColor={theme.colors.text}
            placeholderColor={theme.colors.dim}
            onInput={onNoteInput}
            onChange={onNoteInput}
          />
        </box>
      )}
      {!picker.inputArea ? <text fg={theme.colors.dim} content={truncateToWidth(hintText, contentWidth)} /> : null}
    </OverlayFrame>
  );
}

export function PromptSelectView(
  {
    prompt,
    theme,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    prompt: PromptSelectState | null;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactNode {
  if (!prompt || prompt.options.length === 0) return null;

  const start = Math.max(0, Math.min(
    prompt.selected - Math.floor(maxVisible / 2),
    Math.max(0, prompt.options.length - maxVisible),
  ));
  const end = Math.min(prompt.options.length, start + maxVisible);
  const visibleOptions = prompt.options.slice(start, end);
  const selectedOption = prompt.options[Math.max(0, Math.min(prompt.selected, prompt.options.length - 1))];
  const description = selectedOption?.description?.trim();
  const footerHint = prompt.footerHint?.trim();
  const promptHeight = 1 + visibleOptions.length + (description ? 1 : 0) + (footerHint && !prompt.inputArea ? 1 : 0);

  return (
    <OverlayFrame theme={theme} height={promptHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(prompt.message, contentWidth)} />
      {visibleOptions.map((option, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`prompt-${actualIndex}`}
            theme={theme}
            label={option.label}
            selected={actualIndex === prompt.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      {description ? <text fg={theme.colors.dim} content={truncateToWidth(description, contentWidth)} /> : null}
      {footerHint && !prompt.inputArea ? <text fg={theme.colors.dim} content={truncateToWidth(footerHint, contentWidth)} /> : null}
    </OverlayFrame>
  );
}

export function PromptSecretView(
  {
    prompt,
    inputRef,
    focused,
    onSubmit,
    theme,
  }: {
    prompt: PromptSecretState | null;
    inputRef: React.RefObject<InputRenderable | null>;
    focused: boolean;
    onSubmit: (value: string) => void;
    theme: DisplayTheme;
  },
): React.ReactNode {
  if (!prompt) return null;

  const content = (
    <>
      <text fg={theme.colors.accent} content={prompt.message} />
      <input
        ref={(node) => {
          inputRef.current = node;
        }}
        width="100%"
        placeholder={prompt.allowEmpty ? "Press Enter to confirm, Esc to cancel" : "Enter a value"}
        focused={focused}
        textColor={theme.colors.text}
        focusedTextColor={theme.colors.text}
        placeholderColor={theme.colors.dim}
        onSubmit={onSubmit as any}
      />
      <text fg={theme.colors.dim} content="Enter confirm · Esc cancel" />
    </>
  );

  if (prompt.inputArea) {
    return <box flexDirection="column" gap={0} width="100%" flexShrink={0}>{content}</box>;
  }

  const promptHeight = Math.max(3, prompt.message.split("\n").length + 2);
  return <OverlayFrame theme={theme} height={promptHeight}>{content}</OverlayFrame>;
}

export function OAuthOverlayView(
  {
    state,
    theme,
    contentWidth,
  }: {
    state: OAuthOverlayState | null;
    theme: DisplayTheme;
    contentWidth: number;
  },
): React.ReactNode {
  if (!state) return null;

  const titleText =
    state.provider === "copilot"
      ? "GitHub Copilot Login"
      : "OpenAI ChatGPT Login";

  const { phase } = state;
  if (phase.step === "choose") {
    const options = [
      "Browser login (recommended)",
      "Device code (SSH / headless)",
    ];
    return (
      <OverlayFrame theme={theme} height={options.length + 2}>
        <text fg={theme.colors.accent} content={titleText} />
        {options.map((label, index) => (
          <OverlayOptionRow
            key={`oauth-opt-${index}`}
            theme={theme}
            label={label}
            selected={index === state.selected}
            width={contentWidth}
          />
        ))}
        <text fg={theme.colors.dim} content="Enter select · Esc cancel" />
      </OverlayFrame>
    );
  }

  const lines: string[] = [];
  if (phase.step === "browser_waiting") {
    lines.push("Waiting for browser authorization...");
    lines.push("");
    lines.push(`URL: ${phase.url.length > contentWidth - 5 ? `${phase.url.slice(0, contentWidth - 8)}...` : phase.url}`);
  } else if (phase.step === "device_code") {
    lines.push(`Open:  ${phase.url}`);
    lines.push(`Code:  ${phase.userCode}`);
    lines.push("");
    lines.push("Waiting for sign-in...");
  } else if (phase.step === "polling") {
    lines.push("Waiting for sign-in...");
  } else if (phase.step === "exchanging") {
    lines.push("Exchanging authorization code...");
  } else if (phase.step === "done") {
    lines.push("Login successful!");
  } else if (phase.step === "error") {
    lines.push(`Error: ${phase.message}`);
  }

  return (
    <OverlayFrame theme={theme} height={lines.length + 2}>
      <text fg={theme.colors.accent} content={titleText} />
      {lines.map((line, index) => phase.step === "error" && index === lines.length - 1 ? (
        <ErrorMessage key={`oauth-line-${index}`} text={truncateToWidth(line, contentWidth)} colors={theme.colors} />
      ) : (
        <text key={`oauth-line-${index}`} fg={theme.colors.text} content={truncateToWidth(line, contentWidth)} />
      ))}
      <text fg={theme.colors.dim} content="Esc cancel" />
    </OverlayFrame>
  );
}

// ------------------------------------------------------------------
// Help panel
// ------------------------------------------------------------------

const HELP_SHORTCUTS: Array<{ key: string; action: string }> = [
  { key: "Enter", action: "Send message" },
  { key: "Option+Enter", action: "Insert newline" },
  { key: "Ctrl+C", action: "Cancel / Exit" },
  { key: "Ctrl+V / Ctrl+Y", action: "Paste image (Ctrl+Y for Windows Terminal)" },
  { key: "PageUp/Down", action: "Scroll half page" },
  { key: "↑ / ↓", action: "Browse prompt history" },
  { key: "@filename", action: "Attach file" },
];

export function HelpPanelView(
  { visible, theme, contentWidth }: { visible: boolean; theme: DisplayTheme; contentWidth: number },
): React.ReactNode {
  if (!visible) return null;

  const keyColWidth = Math.max(...HELP_SHORTCUTS.map((s) => s.key.length)) + 2;

  return (
    <OverlayFrame theme={theme} height={HELP_SHORTCUTS.length + 2}>
      <text fg={theme.colors.accent} content="Shortcuts" />
      {HELP_SHORTCUTS.map((shortcut, index) => (
        <text
          key={`help-${index}`}
          fg={theme.colors.text}
          content={truncateToWidth(
            `  ${shortcut.key.padEnd(keyColWidth)}${shortcut.action}`,
            contentWidth,
          )}
        />
      ))}
      <text fg={theme.colors.dim} content="Esc dismiss" />
    </OverlayFrame>
  );
}
