/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

import type { ConversationPalette } from "../components/conversation-types.js";
import { shortenPath } from "../display/utils/format.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });

export type SidebarMode = "open" | "close" | "auto";

export interface RightSidebarProps {
  visible: boolean;
  width: number;
  colors: ConversationPalette;
  cwd: string;
  activeShells?: Array<{ id: string; command: string; status: string }>;
  /** Pre-rendered plan panel */
  planSection?: React.ReactNode;
  /** Pre-rendered context usage card (ContextUsageCard from usage-cards.tsx) */
  contextSection?: React.ReactNode;
  /** Pre-rendered codex usage card (CodexUsageCard from usage-cards.tsx) */
  codexSection?: React.ReactNode;
}

function RightSidebarInner({
  visible,
  width,
  colors,
  cwd,
  activeShells = [],
  planSection,
  contextSection,
  codexSection,
}: RightSidebarProps): React.ReactNode {
  if (!visible) return null;

  return (
    <box
      width={width}
      minWidth={width}
      maxWidth={width}
      flexDirection="column"
      border={["left"] as any}
      borderColor={colors.border}
      borderStyle="single"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      {/* Context usage (reuses ContextUsageCard) */}
      {contextSection ? (
        <box flexDirection="column" width="100%">
          {contextSection}
        </box>
      ) : null}

      {/* Plan checkpoints */}
      {planSection ? (
        <>
          {contextSection ? <box height={1} /> : null}
          <box flexDirection="column" width="100%">
            {planSection}
          </box>
        </>
      ) : null}

      {/* Codex usage (reuses CodexUsageCard) */}
      {codexSection ? (
        <>
          <box height={1} />
          <box flexDirection="column" width="100%">
            {codexSection}
          </box>
        </>
      ) : null}

      {/* Active shells */}
      {activeShells.length > 0 ? (
        <>
          <box height={1} />
          <box flexDirection="column" width="100%">
            <text fg={colors.dim} attributes={ATTRS_BOLD} content="SHELLS" />
            {activeShells.map((shell) => (
              <text
                key={shell.id}
                fg={shell.status === "running" ? colors.green : colors.muted}
                content={`${shell.status === "running" ? "●" : "○"} ${shell.command.slice(0, width - 6)}`}
                truncate
              />
            ))}
          </box>
        </>
      ) : null}

      {/* Project path — pinned to bottom */}
      <box flexDirection="column" width="100%" flexGrow={1} justifyContent="flex-end">
        <text fg={colors.muted} content={shortenPath(cwd)} truncate />
      </box>
    </box>
  );
}

export const RightSidebar = React.memo(RightSidebarInner);
