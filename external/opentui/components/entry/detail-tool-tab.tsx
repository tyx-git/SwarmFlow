/** @jsxImportSource @opentui/react */

import React, { useEffect, useRef, useState } from "react";
import { useRenderer } from "@opentui/react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { FileModifyBody } from "./file-modify-body.js";
import { ScrollViewport } from "../../display/primitives/scroll-viewport.js";
import { SectionHeader } from "../../display/primitives/section-header.js";

interface DetailToolTabProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
  scrollRef: React.RefObject<any>;
}

/** Extra rows materialized above/below the viewport so a fast scroll doesn't
 * reveal un-rendered gaps before the next frame catches up. */
const WINDOW_BUFFER = 12;
/** Generous first-paint window before the frame callback measures the real
 * viewport; corrected within one frame. */
const INITIAL_WINDOW_END = 120;

function DetailToolTabInner(
  { entry, colors, contentWidth, scrollRef }: DetailToolTabProps,
): React.ReactNode {
  const text = entry.toolResultFullText ?? "";
  const streamSections = entry.toolStreamSections ?? [];
  const displayName = entry.toolDisplayName ?? "Tool";
  const toolText = entry.toolText ?? "";
  const title = toolText ? `${displayName} ${toolText}` : displayName;

  const fmd = entry.fileModifyData;
  const usesFmd = !!fmd && (fmd.hunks.length > 0 || (fmd.writeLines != null && fmd.writeLines.length > 0));

  const renderer = useRenderer();
  const [window, setWindow] = useState<{ start: number; end: number }>(
    { start: 0, end: INITIAL_WINDOW_END },
  );
  // Mirror window in a ref so the frame callback compares without re-registering.
  const windowRef = useRef(window);
  windowRef.current = window;

  // Virtualization: track the live scroll offset each frame and only re-window
  // (→ re-materialize visible rows) when the visible range actually moves.
  useEffect(() => {
    if (!usesFmd) return;
    const cb = async (): Promise<void> => {
      const sb = scrollRef.current;
      if (!sb) return;
      const scrollTop = sb.scrollTop ?? 0;
      const viewportHeight = sb.viewport?.height ?? INITIAL_WINDOW_END;
      const start = Math.max(0, Math.floor(scrollTop) - WINDOW_BUFFER);
      const end = Math.ceil(scrollTop + viewportHeight) + WINDOW_BUFFER;
      const prev = windowRef.current;
      if (prev.start !== start || prev.end !== end) {
        setWindow({ start, end });
      }
    };
    renderer.setFrameCallback(cb);
    return () => renderer.removeFrameCallback(cb);
  }, [renderer, scrollRef, usesFmd]);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <SectionHeader label={title} color={colors.dim} paddingLeft={2} paddingBottom={1} />
      <ScrollViewport colors={colors} scrollRef={scrollRef}>
        {usesFmd ? (
          <box paddingLeft={2} paddingRight={2}>
            <FileModifyBody
              data={fmd!}
              colors={colors}
              contentWidth={Math.max(8, contentWidth - 6)}
              streaming={entry.state === "active"}
              window={window}
            />
          </box>
        ) : streamSections.length > 0 ? (
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={0}>
            {streamSections.map((section) => (
              <box key={section.key} flexDirection="column" paddingBottom={1}>
                <text fg={colors.dim} content={`${section.label}${section.complete ? "" : " (streaming)"}`} />
                <text fg={colors.text} content={section.text} wrapMode="char" />
              </box>
            ))}
            {entry.toolRepairedFromPartial ? (
              <text fg={colors.dim} content="(repaired from partial stream)" />
            ) : null}
          </box>
        ) : (
          <box paddingLeft={2} paddingRight={2}>
            <text fg={colors.text} content={text} />
          </box>
        )}
      </ScrollViewport>
    </box>
  );
}

export const DetailToolTab = React.memo(
  DetailToolTabInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
