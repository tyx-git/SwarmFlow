/** @jsxImportSource @opentui/react */
import React from "react";
import { getTreeSitterClient } from "@opentui/core";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
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
  const reserveHeight = entry.assistantStreaming ?? false;
  return (
    <box width="100%" flexShrink={0}>
      {markdownMode === "raw" ? (
        <text fg={colors.text} content={text} />
      ) : (
        <markdown
          content={text}
          syntaxStyle={markdownStyle}
          treeSitterClient={getTreeSitterClient()}
          streaming={entry.assistantStreaming ?? false}
          reserveHeightWhileStreaming={reserveHeight}
          conceal={true}
          concealCode={false}
          internalBlockMode="top-level"
          width="100%"
          flexShrink={0}
          tableOptions={{
            // 使用原生表格的完整宽度；内容宽度模式会让长单元格挤压其他列。
            widthMode: "full",
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
