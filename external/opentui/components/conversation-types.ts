import type { SyntaxStyle } from "@opentui/core";

import type { PresentationEntry } from "../presentation/types.js";
import type {
  DisplayTheme,
  DisplayThemeBrandingTokens,
  DisplayThemeColorTokens,
} from "../display/theme/index.js";

export type ConversationPalette = DisplayThemeColorTokens;

/** Props for the new presentation-layer entry renderers. */
export interface PresentationEntryItemProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  theme: DisplayTheme;
  contentWidth: number;
  markdownMode: "rendered" | "raw";
  diffDisplayMode: "compact" | "full";
  markdownStyle: SyntaxStyle;
  onEntryClick?: (entry: PresentationEntry) => void;
  onAgentClick?: (agentId: string) => void;
}

export interface PresentationPanelProps {
  items: readonly PresentationEntry[];
  colors: ConversationPalette;
  theme: DisplayTheme;
  contentWidth: number;
  markdownMode: "rendered" | "raw";
  diffDisplayMode: "compact" | "full";
  markdownStyle: SyntaxStyle;
  processing: boolean;
  selectedChildId: string | null;
  showLogoInScroll: boolean;
  branding: DisplayThemeBrandingTokens;
  onEntryClick?: (entry: PresentationEntry) => void;
  onAgentClick?: (agentId: string) => void;
}
