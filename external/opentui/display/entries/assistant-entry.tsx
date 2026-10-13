/** @jsxImportSource @opentui/react */
import React from "react";
import { getTreeSitterClient, type SyntaxStyle } from "@opentui/core";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
interface AssistantEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  markdownStyle: SyntaxStyle;
}
export function AssistantEntry({
  entry,
  colors,
  markdownStyle,
}: AssistantEntryProps): React.ReactNode {
  // 模型或历史文本可能带 BOM；它会扰乱开头 Markdown 标记的匹配和隐藏范围，
  // 导致正文丢字或格式标记残留在界面上。
  const text = (entry.assistantText ?? "").replace(/^\uFEFF+/, "");
  const streaming = entry.assistantStreaming === true;
  return (
    <box width="100%" flexShrink={0}>
      <markdown
        content={text}
        syntaxStyle={markdownStyle}
        treeSitterClient={getTreeSitterClient()}
        streaming={streaming}
        conceal={true}
        concealCode={false}
        internalBlockMode="top-level"
        width="100%"
        flexShrink={0}
        tableOptions={{
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
    </box>
  );
}
