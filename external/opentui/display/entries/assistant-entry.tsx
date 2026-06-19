/** @jsxImportSource @opentui/react */

import React from "react";

import { getFermiAssistantRenderer } from "../../forked/core/lib/diagnostic.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
const ASSISTANT_RENDERER_MODE = getFermiAssistantRenderer();

interface AssistantEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  markdownMode: "rendered" | "raw";
  markdownStyle: any;
}

export function AssistantEntry({
  entry,
  colors,
  markdownMode,
  markdownStyle,
}: AssistantEntryProps): React.ReactNode {
  const text = entry.assistantText ?? "";

  // Assistant rendering uses TWO independent signals on purpose. Do not collapse
  // them back into one — they fix two different things and pull in opposite ways.
  //
  // 1) renderedStreaming = true (ALWAYS)
  //    The markdown/code renderable stays in streaming render mode and is never
  //    flipped to false at turn end. Flipping it ran MarkdownRenderable's finalize
  //    (updateBlocks: trailingUnstable 2 -> 0 + re-layout), which snapped the
  //    trailing block's height; the conversation ScrollBox is sticky-bottom, so
  //    that size change re-pinned the scroll and forced an unconditional nextTick
  //    repaint — a full-viewport flicker at the end of EVERY turn. Keeping it true
  //    removes the transition (this is how opencode renders assistant text), so the
  //    flicker never happens. Pinning streaming is safe on the default markdown
  //    renderer: prose blocks get a synchronous initialStyledText and fenced code
  //    uses the synchronous hljs wrapper, so there is no blank-until-highlight on
  //    cold mount (/resume, raw<->rendered toggle). The only blank path is a
  //    whole-message <code> with drawUnstyledText=false, i.e. the non-user
  //    FERMI_OPENTUI_ASSISTANT_RENDERER=code flag.
  //
  // 2) reserveHeightWhileStreaming = entry.assistantStreaming (the REAL state)
  //    The per-width monotonic height floor (a Fermi patch — opencode has no such
  //    floor, which is exactly why opencode can pin streaming with no fallout) must
  //    only be ON while a turn is actively streaming, to absorb the one-frame height
  //    dips from async highlight/conceal. It MUST go OFF once the entry is done.
  //    A completed entry that keeps the floor on caches over-tall per-width
  //    measurements that never reset, which (a) leaves residual trailing space and
  //    (b) makes a block's height non-monotonic in width — at some widths
  //    floor[wider] > floor[narrower]. That inversion turns the vertical scrollbar's
  //    width feedback into a sustained limit cycle: the transcript strobes between
  //    two layouts dozens of times per second at certain terminal widths. Driving
  //    the floor from the real streaming state kills both, while signal (1) keeps
  //    the flicker fix. (Floor off at completion is ~free: with no resize happening
  //    the floor already equals the true height, so nothing snaps.)
  const renderedStreaming = true;
  const reserveHeight = entry.assistantStreaming ?? false;

  return (
    <box paddingTop={1}>
      {markdownMode === "raw" ? (
        <text fg={colors.text} content={text} />
      ) : ASSISTANT_RENDERER_MODE === "code" ? (
        <code
          content={text}
          filetype="markdown"
          syntaxStyle={markdownStyle}
          streaming={renderedStreaming}
          reserveHeightWhileStreaming={reserveHeight}
          conceal={true}
          drawUnstyledText={false}
          fg={colors.text}
          width="100%"
        />
      ) : (
        <markdown
          content={text}
          syntaxStyle={markdownStyle}
          treeSitterClient={undefined}
          streaming={renderedStreaming}
          reserveHeightWhileStreaming={reserveHeight}
          conceal={true}
          concealCode={false}
          internalBlockMode="top-level"
          width="100%"
          tableOptions={{
            widthMode: "content",
            borders: true,
            outerBorder: true,
            borderStyle: "single",
            borderColor: colors.text,
            wrapMode: "word",
            cellPaddingX: 1,
            selectable: true,
          }}
        />
      )}
    </box>
  );
}
