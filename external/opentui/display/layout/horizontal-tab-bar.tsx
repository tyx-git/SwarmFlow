/** @jsxImportSource @opentui/react */

import React, { useState } from "react";

import type { DisplayThemeColorTokens } from "../theme/index.js";
import type { TabState } from "../../sidebar/sidebar-tabs.js";
import { truncateToWidth } from "../utils/format.js";

interface HorizontalTabBarProps {
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  colors: DisplayThemeColorTokens;
  maxTabWidth?: number;
}

const DEFAULT_MAX_TAB_WIDTH = 18;

function formatTabLabel(tab: TabState, maxWidth: number): string {
  const raw = ` ${tab.icon} ${tab.label} `;
  return truncateToWidth(raw, maxWidth);
}

function TabButton({
  tab,
  isActive,
  maxWidth,
  colors,
  onSelect,
  onClose,
}: {
  tab: TabState;
  isActive: boolean;
  maxWidth: number;
  colors: DisplayThemeColorTokens;
  onSelect: () => void;
  onClose: () => void;
}): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  const label = formatTabLabel(tab, maxWidth);
  const fg = isActive ? colors.accent : hovered ? colors.accent : colors.accentDim;
  const totalWidth = Bun.stringWidth(label) + (tab.closeable ? 2 : 0);
  const indicator = isActive ? "─".repeat(totalWidth) : " ".repeat(totalWidth);

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onSelect(); }}
    >
      <box flexDirection="row">
        <text fg={fg} content={label} />
        {tab.closeable ? (
          <box
            onMouseDown={(e: any) => {
              e.stopPropagation();
              e.preventDefault();
              onClose();
            }}
          >
            <text fg={fg} content="✕ " />
          </box>
        ) : null}
      </box>
      <text fg={fg} content={indicator} />
    </box>
  );
}

function HorizontalTabBarInner({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  colors,
  maxTabWidth = DEFAULT_MAX_TAB_WIDTH,
}: HorizontalTabBarProps): React.ReactNode {
  if (tabs.length <= 1) return null;

  return (
    <box flexDirection="row" width="100%" gap={1} flexShrink={0}>
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          maxWidth={maxTabWidth}
          colors={colors}
          onSelect={() => onSelectTab(tab.id)}
          onClose={() => onCloseTab(tab.id)}
        />
      ))}
    </box>
  );
}

export const HorizontalTabBar = React.memo(HorizontalTabBarInner);
