/** @jsxImportSource @opentui/react */
import React from "react";
import {
  CodeRenderable,
  getTreeSitterClient,
  RGBA,
  type MarkdownOptions,
  type Renderable,
  type SyntaxStyle,
} from "@opentui/core";
import { paintFileReferences } from "../../components/path-highlight.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";
interface AssistantEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  markdownStyle: SyntaxStyle;
}

type MarkdownRenderNode = NonNullable<MarkdownOptions["renderNode"]>;

/**
 * 给正文里的文件路径引用补上主题的路径色。
 *
 * 纯文本路径不是 tree-sitter 语法节点，官方只暴露逐块的 chunk 钩子，因此走公开的
 * renderNode + CodeRenderable.onChunks 链路，并保留官方已挂的 linkify 钩子。
 * 列表项和引用块的文字在内层 CodeRenderable 上，必须一起遍历。
 */
function createPathHighlightRenderNode(
  colors: ConversationPalette,
  markdownStyle: SyntaxStyle,
): MarkdownRenderNode {
  const pathFg = RGBA.fromHex(colors.statusSession);
  const lineFg = RGBA.fromHex(colors.orange);
  // 只保护行内代码；链接由官方 linkify 打上 chunk.link，按颜色比对会在
  // brief 这类把 cyan/dim 压成同一灰度的主题里误伤正文。
  const protectedColors = [
    markdownStyle.getStyle("markup.raw")?.fg,
    markdownStyle.getStyle("markup.raw.block")?.fg,
  ];
  // 块更新会复用同一个实例，缺少标记时钩子会被逐帧重复包装。
  const wrapped = new WeakSet<CodeRenderable>();

  const wrap = (node: Renderable | null): void => {
    if (!node) return;
    if (node instanceof CodeRenderable && node.filetype === "markdown" && !wrapped.has(node)) {
      wrapped.add(node);
      const linkify = node.onChunks;
      node.onChunks = async (chunks, context) => {
        const linked = linkify ? await linkify(chunks, context) : undefined;
        return paintFileReferences(linked ?? chunks, { pathFg, lineFg }, protectedColors);
      };
    }
    for (const child of node.getChildren?.() ?? []) {
      wrap(child as Renderable);
    }
  };

  return (_token, context) => {
    const renderable = context.defaultRender();
    wrap(renderable);
    return renderable;
  };
}

export function AssistantEntry({
  entry,
  colors,
  markdownStyle,
}: AssistantEntryProps): React.ReactNode {
  // 模型、历史文本或复制粘贴可能夹带 BOM；它会扰乱 Markdown 匹配并出现在界面上。
  const text = (entry.assistantText ?? "").replace(/\uFEFF/g, "");
  const streaming = entry.assistantStreaming === true;
  // renderNode 换身份会让官方实现重建全部块，因此按主题稳定记忆。
  const renderNode = React.useMemo(
    () => createPathHighlightRenderNode(colors, markdownStyle),
    [colors, markdownStyle],
  );
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
        renderNode={renderNode}
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
