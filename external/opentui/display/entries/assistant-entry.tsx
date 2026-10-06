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
  // 保持 Markdown 的增量解析模式，避免最后一个块在收尾时被整体重建。
  // 高度保留单独跟随真实流式状态，完成后不会留下额外的高度。
  const renderedStreaming = true;
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
          streaming={renderedStreaming}
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
