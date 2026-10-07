/** @jsxImportSource @opentui/react */

import React from "react";

import type { ConversationPalette } from "../conversation-types.js";
import { ScrollViewport } from "../../display/primitives/scroll-viewport.js";
import { formatDuration } from "../../display/utils/format.js";
import { CommandText } from "./command-text.js";

/** Live data for the shell detail tab (mirrors Session.getBackgroundShellDetail). */
export interface ShellDetailData {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  elapsedSeconds: number;
  recentOutput: string[];
  logPath: string;
  logTail: string;
  logTruncated: boolean;
}

interface DetailShellTabProps {
  shellId: string;
  detail: ShellDetailData | null;
  colors: ConversationPalette;
  scrollRef: React.RefObject<any>;
  onStop?: (shellId: string) => void;
}

function DetailShellTabInner(
  { shellId, detail, colors, scrollRef, onStop }: DetailShellTabProps,
): React.ReactNode {
  if (!detail) {
    return (
      <box flexDirection="column" flexGrow={1} width="100%" paddingLeft={2} paddingTop={1}>
        <text fg={colors.dim} content={`Shell '${shellId}' is no longer tracked.`} />
      </box>
    );
  }

  const running = detail.status === "running";
  const statusBits: string[] = [detail.status, formatDuration(detail.elapsedSeconds)];
  if (detail.exitCode !== null) statusBits.push(`exit ${detail.exitCode}`);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingLeft={2} paddingBottom={0}>
        <CommandText text={`❯ ${detail.command}`} colors={colors} mode="command" wrapMode="char" />
      </box>
      <box flexDirection="row" paddingLeft={2} paddingBottom={1} gap={1}>
        <text
          fg={running ? colors.green : colors.muted}
          content={`${running ? "●" : "○"} ${statusBits.join(" · ")}`}
        />
        {running && onStop ? (
          <box
            backgroundColor={colors.dangerChipBg}
            flexShrink={0}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onStop(detail.id); }}
          >
            <text fg={colors.dangerChipFg} content=" ✕ stop " />
          </box>
        ) : null}
      </box>
      <ScrollViewport colors={colors} scrollRef={scrollRef} stickyScroll={true} stickyStart="bottom">
        <box flexDirection="column" paddingLeft={2} paddingRight={2}>
          {detail.logTruncated ? (
            <text fg={colors.dim} content={`[Tail only — earlier output omitted. Full log: ${detail.logPath}]`} />
          ) : null}
          <CommandText text={detail.logTail || "(no output yet)"} colors={colors} mode="output" wrapMode="char" />
        </box>
      </ScrollViewport>
    </box>
  );
}

export const DetailShellTab = React.memo(
  DetailShellTabInner,
  (prev, next) =>
    prev.shellId === next.shellId
    && prev.detail === next.detail
    && prev.colors === next.colors,
);
