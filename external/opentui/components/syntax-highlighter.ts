/**
 * 独立工具行的高亮适配器。
 *
 * Markdown 消息直接使用 OpenTUI 原生 MarkdownRenderable；只有需要把差异前缀、
 * 文件路径和语法着色源码组合到同一 StyledText 行时才使用本模块。
 */
import { createRequire } from "node:module";
import { RGBA, type TextChunk } from "@opentui/core";
import { getThemeColors } from "../display/theme/color-config.js";
import type { ThemeMode } from "../display/theme/types.js";
import { isShikiReady, shikiHighlightToChunks } from "../forked/shiki-highlighter.js";

const requireModule = createRequire(import.meta.url);
let hljs: any = null;
let hljsLoadAttempted = false;
let currentThemeMode: ThemeMode = "brief";

export function setSyntaxHighlightTheme(mode: ThemeMode): void {
  currentThemeMode = mode;
}

function getHljs(): any {
  if (hljsLoadAttempted) return hljs;
  hljsLoadAttempted = true;
  try {
    hljs = requireModule("highlight.js");
  } catch {
    hljs = null;
  }
  return hljs;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function hljsHtmlToChunks(html: string): TextChunk[] {
  const fallback = RGBA.fromHex(getThemeColors(currentThemeMode).markdown.codeForeground);
  const colors = getThemeColors(currentThemeMode).markdown.hljs;
  const stack: RGBA[] = [fallback];
  const chunks: TextChunk[] = [];
  let offset = 0;

  while (offset < html.length) {
    const tagStart = html.indexOf("<", offset);
    if (tagStart < 0) {
      const text = unescapeHtml(html.slice(offset));
      if (text) chunks.push({ __isChunk: true, text, fg: stack[stack.length - 1] });
      break;
    }
    if (tagStart > offset) {
      const text = unescapeHtml(html.slice(offset, tagStart));
      if (text) chunks.push({ __isChunk: true, text, fg: stack[stack.length - 1] });
    }

    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd < 0) break;
    const tag = html.slice(tagStart, tagEnd + 1);
    if (tag.startsWith("</")) {
      if (stack.length > 1) stack.pop();
    } else {
      const className = tag.match(/class="([^"]+)"/)?.[1];
      let color = fallback;
      for (const name of className?.split(/\s+/) ?? []) {
        const configured = colors[name];
        if (configured) {
          color = RGBA.fromHex(configured);
          break;
        }
      }
      stack.push(color);
    }
    offset = tagEnd + 1;
  }
  return chunks;
}

/** 优先使用成熟的 Shiki 路径，语言不可用时回退到 Highlight.js。 */
export function highlightToChunks(code: string, language: string | undefined): TextChunk[] | null {
  if (!language) return null;
  if (isShikiReady()) {
    const shiki = shikiHighlightToChunks(code, language);
    if (shiki) return shiki;
  }

  const highlighter = getHljs();
  if (!highlighter || !highlighter.getLanguage(language)) return null;
  try {
    const result = highlighter.highlight(code, { language, ignoreIllegals: true });
    return hljsHtmlToChunks(result.value);
  } catch {
    return null;
  }
}
