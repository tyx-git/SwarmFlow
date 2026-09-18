/** @jsxImportSource @opentui/react */

import React from "react";

import type { ConversationPalette } from "../components/conversation-types.js";
import { SelectableRow } from "../display/primitives/selectable-row.js";

export interface TabState {
  id: string;
  label: string;
  icon: string;
  closeable: boolean;
  kind: "main" | "child" | "detail-tool" | "detail-shell";
  /** Which session this detail tab's entries come from: "main" or "child:{id}" */
  sourceSessionKey?: string;
  /** The entry id for detail tabs */
  detailEntryId?: string;
  /** Frozen entry data (when source session is archived) */
  frozenEntry?: import("../presentation/types.js").PresentationEntry;
  /** Tracked background shell id for detail-shell tabs */
  shellId?: string;
}

interface SidebarTabsProps {
  tabs: TabState[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  colors: ConversationPalette;
  expanded: boolean;
}

function SidebarTabsInner(
  { tabs, activeTabId, onSelect, onClose, colors, expanded }: SidebarTabsProps,
): React.ReactNode {
  return (
    <box flexDirection="column" width="100%">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <SelectableRow
            key={tab.id}
            width="100%"
            hoverBackgroundColor={colors.border}
            onPress={() => onSelect(tab.id)}
          >
            <box
              flexDirection="row"
              width="100%"
              backgroundColor={isActive ? colors.border : "transparent"}
            >
              <text
                fg={isActive ? colors.accent : colors.dim}
                content={expanded ? ` ${tab.icon} ${tab.label}` : ` ${tab.icon}`}
              />
              {expanded && tab.closeable ? (
                <box
                  flexGrow={1}
                  onMouseDown={(e: any) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onClose(tab.id);
                  }}
                >
                  <text fg={colors.dim} content=" ×" />
                </box>
              ) : null}
            </box>
          </SelectableRow>
        );
      })}
    </box>
  );
}

export const SidebarTabs = React.memo(SidebarTabsInner);
