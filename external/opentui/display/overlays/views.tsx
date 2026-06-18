/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable } from "@opentui/core";
import type { CommandPickerState } from "../../../src/ui/command-picker.js";
import {
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  isCommandPickerActive,
  isCommandPickerCustomInputOption,
} from "../../../src/ui/command-picker.js";
import type { CheckboxPickerState } from "../../../src/ui/checkbox-picker.js";
import {
  getCheckboxPickerVisibleRange,
  isCheckboxPickerActive,
} from "../../../src/ui/checkbox-picker.js";
import type { DisplayTheme } from "../theme/index.js";
import type {
  CommandOverlayState,
  OAuthOverlayState,
  PromptSecretState,
  PromptSelectState,
} from "../types.js";
import { truncateToWidth } from "../utils/format.js";
import { PanelSurface } from "../primitives/panel-surface.js";
import { SelectableRow } from "../primitives/selectable-row.js";

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
  labelParts?: Array<{ text: string; color?: SemanticColor }>;
  detail?: string;
  detailColor?: SemanticColor;
  /** Fixed column width for detail text (for cross-row alignment). */
  detailColumnWidth?: number;
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
  labelParts,
  detail,
  detailColor,
  detailColumnWidth,
  selected,
  disabled = false,
  width,
  onPress,
}: OverlayOptionRowProps): React.ReactNode {
  const isSelected = selected && !disabled;
  const fg = disabled ? theme.colors.muted : isSelected ? theme.colors.accent : theme.colors.dim;
  const prefix = isSelected ? "> " : "  ";

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
  const start = Math.max(0, Math.min(
    overlay.selected - Math.floor(maxVisible / 2),
    Math.max(0, overlay.items.length - maxVisible),
  ));
  const end = Math.min(overlay.items.length, start + maxVisible);
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
    onItemClick,
    noteInputRef,
    noteValue,
    onNoteInput,
  }: {
    picker: CommandPickerState | null;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
    noteInputRef?: React.RefObject<InputRenderable | null>;
    noteValue?: string;
    onNoteInput?: (value: string) => void;
  },
): React.ReactNode {
  if (!isCommandPickerActive(pickerProp)) return null;

  const picker = { ...pickerProp, maxVisible };
  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);
  const inlineInputLines = (picker.noteEditing || picker.customInputMode) ? 2 : 0;
  const hintLine = 1;
  const pickerHeight = 1 + visibleOptions.length + inlineInputLines + hintLine;
  const rootTitle = picker.title ?? picker.commandName;
  const title = path.length > 0
    ? `${rootTitle} 鈥?${path.join(" 鈥?")}`
    : rootTitle;

  // Compute max detail width for column alignment
  const hasAnyDetail = visibleOptions.some(o => o.detail !== undefined);
  const detailColumnWidth = hasAnyDetail
    ? Math.max(...visibleOptions.map(o => (o.detail ?? "").length))
    : 0;

  const isOnCustomInputOption = isCommandPickerCustomInputOption(picker);
  const showTabHint = picker.allowNote && !isOnCustomInputOption;
  const hintText = picker.noteEditing || picker.customInputMode
    ? "Enter confirm 路 Esc cancel"
    : showTabHint
      ? "鈫戔啌 navigate 路 Enter select 路 Tab add instructions 路 Esc cancel"
      : "鈫戔啌 navigate 路 Enter select 路 Esc cancel";

  return (
    <OverlayFrame theme={theme} height={pickerHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(title, contentWidth)} />
      {visibleOptions.map((item, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`picker-${picker.stack.length}-${actualIndex}`}
            theme={theme}
            label={item.label}
            labelParts={item.labelParts}
            detail={item.detail}
            detailColor={item.detailColor}
            detailColumnWidth={detailColumnWidth}
            selected={actualIndex === level.selected}
            disabled={item.disabled}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      {(picker.noteEditing || picker.customInputMode) && (
        <box flexDirection="column">
          <text
            fg={theme.colors.accent}
            content={picker.customInputMode
              ? (picker.customInputLabel ?? "Your instructions:")
              : "Instructions:"}
          />
          <input
            ref={(node) => { if (noteInputRef) (noteInputRef as React.MutableRefObject<InputRenderable | null>).current = node; }}
            value={noteValue ?? ""}
            focused={picker.noteEditing || picker.customInputMode}
            placeholder={picker.customInputMode
              ? (picker.customInputPlaceholder ?? "Type your instructions")
              : "Add review instructions..."}
            textColor={theme.colors.text}
            focusedTextColor={theme.colors.text}
            placeholderColor={theme.colors.dim}
            onInput={onNoteInput}
            onChange={onNoteInput}
          />
        </box>
      )}
      <text fg={theme.colors.dim} content={truncateToWidth(hintText, contentWidth)} />
    </OverlayFrame>
  );
}

export function CheckboxPickerView(
  {
    picker,
    theme,
    contentWidth,
    onItemClick,
  }: {
    picker: CheckboxPickerState | null;
    theme: DisplayTheme;
    contentWidth: number;
    onItemClick: (index: number) => void;
  },
): React.ReactNode {
  if (!isCheckboxPickerActive(picker)) return null;

  const { start, end } = getCheckboxPickerVisibleRange(picker);
  const visibleItems = picker.items.slice(start, end);
  const pickerHeight = 1 + visibleItems.length + 1;

  return (
    <OverlayFrame theme={theme} height={pickerHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(picker.title, contentWidth)} />
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        const checkbox = item.checked ? "[x]" : "[ ]";
        return (
          <OverlayOptionRow
            key={`checkbox-${actualIndex}`}
            theme={theme}
            label={`${checkbox} ${item.label}`}
            selected={actualIndex === picker.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      <text fg={theme.colors.dim} content={truncateToWidth("Space toggle 路 Enter confirm 路 Esc cancel", contentWidth)} />
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
  const promptHeight = 1 + visibleOptions.length + (description ? 1 : 0) + (footerHint ? 1 : 0);

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
      {footerHint ? <text fg={theme.colors.dim} content={truncateToWidth(footerHint, contentWidth)} /> : null}
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

  const promptHeight = Math.max(3, prompt.message.split("\n").length + 2);

  return (
    <OverlayFrame theme={theme} height={promptHeight}>
      <text fg={theme.colors.accent} content={prompt.message} />
      <input
        ref={(node) => {
          inputRef.current = node;
        }}
        placeholder={prompt.allowEmpty ? "Press Enter to confirm, Esc to cancel" : "Enter a value"}
        focused={focused}
        textColor={theme.colors.text}
        focusedTextColor={theme.colors.text}
        placeholderColor={theme.colors.dim}
        onSubmit={onSubmit as any}
      />
      <text fg={theme.colors.dim} content="Enter confirm 路 Esc cancel" />
    </OverlayFrame>
  );
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
        <text fg={theme.colors.dim} content="Enter select 路 Esc cancel" />
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
      {lines.map((line, index) => (
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
  { key: "Ctrl+G", action: "Toggle markdown raw view" },
  { key: "Ctrl+Q", action: "Cycle permission mode" },
  { key: "Ctrl+V / Ctrl+Y", action: "Paste image (Ctrl+Y for Windows Terminal)" },
  { key: "Ctrl+X", action: "Kill all sub-agents" },
  { key: "Ctrl+K", action: "Kill all background shells" },
  { key: "PageUp/Down", action: "Scroll half page" },
  { key: "鈫?/ 鈫?, action: "Browse prompt history" },
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
