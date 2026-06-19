/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

import type { ConversationPalette } from "../components/conversation-types.js";
import { SidebarTabs, type TabState } from "./sidebar-tabs.js";
import type { DisplayThemeBrandingTokens } from "../display/theme/index.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });

interface SidebarProps {
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  width: number;
  collapsedWidth: number;
  colors: ConversationPalette;
  branding: DisplayThemeBrandingTokens;
  /** Pre-rendered context usage section (passed from parent to avoid moving formatters) */
  contextSection?: React.ReactNode;
  /** Pre-rendered codex usage section */
  codexSection?: React.ReactNode;
}

function SidebarTitle(
  {
    expanded,
    branding,
  }: {
    expanded: boolean;
    branding: DisplayThemeBrandingTokens;
  },
): React.ReactNode {
  if (!expanded) {
    return (
      <box flexDirection="row">
        <text fg={branding.logoGradient[0]} attributes={ATTRS_BOLD} content={branding.sidebarWordmark[0] ?? "V"} />
      </box>
    );
  }
  return (
    <box flexDirection="row">
      {branding.sidebarWordmark.split("").map((ch, i) => (
        <text
          key={`sidebar-title-${i}`}
          fg={branding.logoGradient[branding.sidebarGradientIndices[i] ?? 0]}
          attributes={ATTRS_BOLD}
          content={ch}
        />
      ))}
    </box>
  );
}

function LeftSidebarInner(props: SidebarProps): React.ReactNode {
  const {
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    expanded,
    onToggleExpanded,
    width: expandedWidth,
    collapsedWidth,
    colors,
    branding,
    contextSection,
    codexSection,
  } = props;

  const width = expanded ? expandedWidth : collapsedWidth;

  return (
    <box
      width={width}
      minWidth={width}
      maxWidth={width}
      flexDirection="column"
      border={["right"] as any}
      borderColor={colors.border}
      borderStyle="single"
    >
      <box
        flexDirection="row"
        paddingLeft={1}
        onMouseDown={(e: any) => {
          e.stopPropagation();
          e.preventDefault();
          onToggleExpanded();
        }}
      >
        <text fg={colors.dim} content={expanded ? "▾ " : "▸ "} />
        <SidebarTitle expanded={expanded} branding={branding} />
      </box>

      <box height={1} />

      <SidebarTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        colors={colors}
        expanded={expanded}
      />

      {expanded && (contextSection || codexSection) ? (
        <>
          <box height={1} />
          <box paddingLeft={1} flexDirection="column" gap={1} width="100%">
            {contextSection}
            {codexSection}
          </box>
        </>
      ) : null}
    </box>
  );
}

export const LeftSidebar = React.memo(LeftSidebarInner);
