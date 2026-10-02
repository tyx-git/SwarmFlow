// @ts-nocheck
import { createRequire } from "node:module";
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  RGBA,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import type { ColorInput, TextChunk } from "@opentui/core";
import type { MarkedToken, Tokens } from "marked";
import {
  isMarkdownPatchDisabled,
  writeOpenTuiDiag,
} from "./core/lib/diagnostic.js";
import { createMarkdownSyntheticBlockHighlighter } from "./core/renderables/MarkdownHighlightContext.js";
import { inferCodeFiletype } from "./core/lib/tree-sitter/resolve-ft.js";
import { clipboard } from "../../../src/platform/index.js";
import type { DisplayTheme } from "../display/theme/types.js";
import { isShikiReady, setShikiTheme, shikiHighlightToChunks } from "./shiki-highlighter.js";
import { getUiCommonColors } from "../../../src/config/ui-colors.js";

/**
 * When `true`, `highlightToChunks` uses Shiki (TextMate grammars, VS Code
 * themes) instead of highlight.js.  Requires `initShikiHighlighter()` to
 * have been called at startup.
 *
 * Set to `false` (default) to keep the original highlight.js path.
 */
export let useShikiHighlighter = true;

/** Toggle Shiki on/off at runtime. */
export function setUseShikiHighlighter(value: boolean): void {
  useShikiHighlighter = value;
}

const PATCH_FLAG = Symbol.for("swarmflow.opentui.markdown.patch.v5");
const INNER_TEXT = Symbol.for("swarmflow.codeblock.renderable");
const LABEL_REF = Symbol.for("swarmflow.codeblock.label");
const COPY_REF = Symbol.for("swarmflow.codeblock.copy");
const CODE_CONTENT = Symbol.for("swarmflow.codeblock.rawcontent");
const COALESCED_MARGIN_TOP = Symbol.for("swarmflow.opentui.markdown.coalesced.marginTop");
const TRAILING_MARKDOWN_BLOCK_BREAKS_RE = /(?:\r?\n){2,}$/;
const TRAILING_MARKDOWN_BLOCK_NEWLINES_RE = /(?:\r?\n)+$/;
const ANY_MARKDOWN_BLOCK_BREAK_RE = /(?:\r?\n){2,}/;
const FRONT_MATTER_OPENER_RE = /^(?:---|\+\+\+)(?:[ \t]*(?:\r?\n|$))/;

// Runtime-mutable theme bound by `applyMarkdownTheme`. The patched render
// closures read these on every call, so swapping the theme reflects on the
// next render. Defaults to inert values until applyMarkdownTheme is called.
const CORE_COLORS = getUiCommonColors().openTuiCore;
const FALLBACK_FG = RGBA.fromHex(CORE_COLORS.markdownFallback);
const currentMarkdownTheme: {
  codeBorder: string;
  codeBorderHover: string;
  codeLabelFg: string;
  codeCopyFg: string;
  codeCopyFlash: string;
  codeFg: RGBA;
  hljs: Record<string, RGBA>;
} = {
  codeBorder: CORE_COLORS.markdownBorder,
  codeBorderHover: CORE_COLORS.markdownBorderHover,
  codeLabelFg: CORE_COLORS.markdownLabel,
  codeCopyFg: CORE_COLORS.markdownCopy,
  codeCopyFlash: CORE_COLORS.markdownCopyFlash,
  codeFg: FALLBACK_FG,
  hljs: {},
};

/** Re-bind markdown render colors. Call on theme switch. */
export function applyMarkdownTheme(theme: DisplayTheme): void {
  currentMarkdownTheme.codeBorder = theme.markdown.codeBorder;
  currentMarkdownTheme.codeBorderHover = theme.markdown.codeBorderHover;
  currentMarkdownTheme.codeLabelFg = theme.markdown.codeLabelForeground;
  currentMarkdownTheme.codeCopyFg = theme.markdown.codeCopyForeground;
  currentMarkdownTheme.codeCopyFlash = theme.markdown.codeCopyFlash;
  currentMarkdownTheme.codeFg = RGBA.fromHex(theme.markdown.codeForeground);
  currentMarkdownTheme.hljs = Object.fromEntries(
    Object.entries(theme.markdown.hljs).map(([key, value]) => [key, RGBA.fromHex(value)]),
  ) as Record<string, RGBA>;
  for (const wrapper of CODE_BLOCK_WRAPPERS) {
    if (!wrapper.isDestroyed) refreshCodeBlockTheme(wrapper);
  }
  // Keep the shiki highlighter (TextMate path used for fenced code blocks) in
  // sync with the same mode, so dark/light terminals get readable code.
  setShikiTheme(theme.mode);
}

// ── highlight.js integration ────────────────────────────────────────────────

let hljs: any = null;
let hljsLoadAttempted = false;
const requireModule = createRequire(import.meta.url);

function getHljs(): any {
  if (hljsLoadAttempted) return hljs;
  hljsLoadAttempted = true;
  try {
    // 优先沿 marked-terminal 的依赖链解析 highlight.js。
    const req = createRequire(requireModule.resolve("marked-terminal"));
    hljs = req("highlight.js");
  } catch {
    try {
      hljs = requireModule("highlight.js");
    } catch {
      // not available
    }
  }
  return hljs;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

/**
 * Parse highlight.js HTML into TextChunk[] with fg colors.
 */
function hljsHtmlToChunks(html: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const codeFg = currentMarkdownTheme.codeFg;
  const hljs = currentMarkdownTheme.hljs;
  const colorStack: (RGBA | undefined)[] = [codeFg];

  let pos = 0;
  while (pos < html.length) {
    const nextTag = html.indexOf("<", pos);
    if (nextTag === -1) {
      // Remaining text
      const text = unescapeHtml(html.slice(pos));
      if (text) chunks.push({ __isChunk: true, text, fg: colorStack[colorStack.length - 1] });
      break;
    }

    // Text before tag
    if (nextTag > pos) {
      const text = unescapeHtml(html.slice(pos, nextTag));
      if (text) chunks.push({ __isChunk: true, text, fg: colorStack[colorStack.length - 1] });
    }

    if (html.startsWith("</", nextTag)) {
      // Closing tag
      const tagEnd = html.indexOf(">", nextTag);
      if (tagEnd === -1) break;
      if (colorStack.length > 1) colorStack.pop();
      pos = tagEnd + 1;
    } else {
      // Opening tag
      const tagEnd = html.indexOf(">", nextTag);
      if (tagEnd === -1) break;
      const tag = html.slice(nextTag, tagEnd + 1);
      const classMatch = tag.match(/class="([^"]+)"/);
      let color: RGBA | undefined = codeFg;
      if (classMatch) {
        const classes = classMatch[1].split(/\s+/);
        for (const cls of classes) {
          if (hljs[cls]) { color = hljs[cls]; break; }
        }
      }
      colorStack.push(color);
      pos = tagEnd + 1;
    }
  }

  return chunks;
}

export function highlightToChunks(code: string, lang: string | undefined): TextChunk[] | null {
  // ── Shiki path (opt-in) ──────────────────────────────────────────────────
  if (useShikiHighlighter && isShikiReady()) {
    const shikiResult = shikiHighlightToChunks(code, lang);
    if (shikiResult) return shikiResult;
    // Language not loaded yet or unsupported — fall through to hljs.
  }

  // ── highlight.js path (default) ──────────────────────────────────────────
  // Only highlight when an explicit, known language is given.  No auto-detect:
  // blocks without a language tag (```...```) render as plain text so we don't
  // mis-colorize prose, shell output, or random pasted content.
  const h = getHljs();
  if (!h) return null;
  if (!lang || !h.getLanguage(lang)) return null;

  try {
    const result = h.highlight(code, { language: lang, ignoreIllegals: true });
    return hljsHtmlToChunks(result.value);
  } catch {
    return null;
  }
}

/**
 * Tree-sitter 有捕获结果时优先使用它；本地没有解析器的语言继续走
 * Shiki/highlight.js fallback，避免整个 fenced block 降级为纯文本。
 */
function fallbackCodeChunks(
  chunks: TextChunk[],
  context: { content: string; filetype: string; highlights: unknown[] },
): TextChunk[] {
  if (context.highlights.length > 0) return chunks;
  const language = context.filetype === "typescriptreact"
    ? "typescript"
    : context.filetype === "javascriptreact"
      ? "javascript"
      : context.filetype;
  return highlightToChunks(context.content, language) ?? chunks;
}

// ── Markdown prototype patches ──────────────────────────────────────────────

type MarkdownRenderablePatched = InstanceType<typeof MarkdownRenderable> & {
  _syntaxStyle: unknown;
  _conceal: boolean;
  _concealCode: boolean;
  _streaming: boolean;
  _reserveHeightWhileStreaming?: boolean;
  _treeSitterClient?: unknown;
  _linkifyMarkdownChunks?: unknown;
  getStyle?: (group: string) => { fg?: ColorInput } | undefined;
  createMarkdownBlockToken: (raw: string, marginTop?: number) => MarkedToken;
  shouldRenderSeparately: (token: MarkedToken) => boolean;
  normalizeMarkdownBlockRaw: (raw: string) => string;
}

type CoalescedLayoutToken = MarkedToken & {
  [COALESCED_MARGIN_TOP]?: number;
};

type WrappedBox = InstanceType<typeof BoxRenderable> & {
  [INNER_TEXT]?: InstanceType<typeof CodeRenderable>;
  [LABEL_REF]?: InstanceType<typeof TextRenderable>;
  [COPY_REF]?: InstanceType<typeof TextRenderable>;
  [CODE_CONTENT]?: string;
};

const CODE_BLOCK_WRAPPERS = new Set<WrappedBox>();

function refreshCodeBlockTheme(wrapper: WrappedBox): void {
  wrapper.borderColor = currentMarkdownTheme.codeBorder;
  const code = wrapper[INNER_TEXT];
  if (code) code.fg = currentMarkdownTheme.codeFg;
  const label = wrapper[LABEL_REF];
  if (label) label.fg = currentMarkdownTheme.codeLabelFg;
  const copy = wrapper[COPY_REF];
  if (copy) copy.fg = currentMarkdownTheme.codeCopyFg;
};

const proto = MarkdownRenderable.prototype as MarkdownRenderablePatched & Record<PropertyKey, unknown>;

function setCoalescedMarginTop(token: MarkedToken, marginTop: number): void {
  (token as CoalescedLayoutToken)[COALESCED_MARGIN_TOP] = marginTop;
}

function normalizeInterTokenSpace(raw: string): string {
  return ANY_MARKDOWN_BLOCK_BREAK_RE.test(raw) ? "\n\n" : raw;
}

if (isMarkdownPatchDisabled()) {
  writeOpenTuiDiag("markdown.patch", {
    applied: false,
    reason: "disabled-by-env",
  });
} else if (!proto[PATCH_FLAG]) {
  proto[PATCH_FLAG] = true;
  writeOpenTuiDiag("markdown.patch", {
    applied: true,
    version: "v5",
  });

  proto.getInterBlockMargin = function getInterBlockMarginPatched(): number {
    return 0;
  };

  proto.normalizeMarkdownBlockRaw = function normalizeMarkdownBlockRawPatched(raw: string): string {
    return raw;
  };

  proto.buildRenderableTokens = function buildRenderableTokensPatched(tokens: MarkedToken[]): MarkedToken[] {
    // 0.4.1: custom render-node path bypasses coalescing (unless it's a
    // code-block-only renderer). Mirror the in-tree guard so the patched
    // coalescer doesn't run for custom-rendered markdown.
    if (this._renderNode && !this.isCodeBlockOnlyRenderer()) {
      return tokens.filter((token) => token.type !== "space");
    }

    const renderTokens: MarkedToken[] = [];
    let markdownRaw = "";
    let markdownMarginTop = 0;
    let pendingGapBeforeNext = "";

    const getNextMarginTop = (gapBeforeNext: string, currentIsSeparate: boolean): number => {
      const prev = renderTokens[renderTokens.length - 1];
      if (!prev) return 0;
      // Mirror core/renderables/Markdown.ts: a separately-rendered block (code/table/
      // blockquote/hr) always keeps one separator row from preceding content, even when
      // the source is "tight" (no blank line). This monkeypatch wins at app runtime, so
      // the in-tree fix must be duplicated here or it is silently reverted in production.
      return currentIsSeparate ||
        this.shouldRenderSeparately(prev) ||
        TRAILING_MARKDOWN_BLOCK_BREAKS_RE.test(prev.raw + gapBeforeNext)
        ? 1
        : 0;
    };

    const flushMarkdownRaw = (): string => {
      if (markdownRaw.length === 0) return "";
      const normalizedRaw = this.normalizeMarkdownBlockRaw(markdownRaw);
      const trailingGap = TRAILING_MARKDOWN_BLOCK_BREAKS_RE.test(normalizedRaw) ? "\n\n" : "";
      const trimmedRaw = normalizedRaw.replace(TRAILING_MARKDOWN_BLOCK_NEWLINES_RE, "");
      if (trimmedRaw.length > 0) {
        renderTokens.push(this.createMarkdownBlockToken(trimmedRaw, markdownMarginTop));
      }
      markdownRaw = "";
      markdownMarginTop = 0;
      return trailingGap;
    };

    for (const token of tokens) {
      if (token.type === "space") {
        if (markdownRaw.length > 0) {
          markdownRaw += normalizeInterTokenSpace(token.raw);
        } else {
          pendingGapBeforeNext += token.raw;
        }
        continue;
      }

      if (this.shouldRenderSeparately(token)) {
        const trailingGap = flushMarkdownRaw();
        setCoalescedMarginTop(token, getNextMarginTop(trailingGap || pendingGapBeforeNext, true));
        renderTokens.push(token);
        pendingGapBeforeNext = "";
        continue;
      }

      if (markdownRaw.length === 0) {
        markdownMarginTop = getNextMarginTop(pendingGapBeforeNext, false);
        pendingGapBeforeNext = "";
      }
      markdownRaw += token.raw;
    }

    flushMarkdownRaw();
    return renderTokens;
  };

  proto.createMarkdownCodeRenderable = function createMarkdownCodeRenderablePatched(
    content: string,
    id: string,
    marginBottom: number = 0,
    onChunks: any = this._linkifyMarkdownChunks,
    baseHighlight?: string,
    initialStyledText?: any,
  ) {
    return new CodeRenderable(this.ctx, {
      id,
      content,
      filetype: "markdown",
      syntaxStyle: this._syntaxStyle as any,
      fg: this._fg,
      bg: this._bg,
      conceal: this._conceal,
      // 0.4.1: draw raw text only while the precomputed styled text is present.
      drawUnstyledText: initialStyledText !== undefined,
      streaming: true,
      // : per-width height floor — follows the explicit reserve flag when
      // set (lets completed entries disable it), else falls back to streaming.
      reserveHeightWhileStreaming: this._reserveHeightWhileStreaming ?? this._streaming,
      initialStyledText,
      baseHighlight,
      // front matter 需要原有的偏移高亮查询；普通 Markdown 同步返回，
      // 避免每个流式 token 都等待 synthetic Promise。
      onHighlight: (() => {
        const synthetic = createMarkdownSyntheticBlockHighlighter(() => this._treeSitterClient);
        return (highlights: any, context: any) =>
          FRONT_MATTER_OPENER_RE.test(context.content) ? synthetic(highlights, context) : undefined;
      })(),
      onChunks: (chunks: TextChunk[], context: any) => {
        // OpenTUI 的链接检测当前是同步的；如果后续 fork 返回 Promise，
        // 仍保留 Tree-sitter chunks，避免某一帧被清空。
        try {
          const transformed = onChunks(chunks, context);
          if (transformed && typeof transformed.then === "function") return chunks;
          return transformed ?? chunks;
        } catch {
          return chunks;
        }
      },
      treeSitterClient: this._treeSitterClient as any,
      width: "100%",
      marginBottom,
    });
  };

  function buildCodeBlockWrapper(
    ctx: any,
    codeText: InstanceType<typeof CodeRenderable>,
    rawContent: string,
    lang: string,
    marginBottom: number,
  ): WrappedBox {
    const wrapper = new BoxRenderable(ctx, {
      flexDirection: "column",
      width: "100%",
      border: true,
      borderColor: currentMarkdownTheme.codeBorder,
      borderStyle: "rounded",
      marginBottom,
    }) as WrappedBox;
    CODE_BLOCK_WRAPPERS.add(wrapper);
    wrapper.on("destroyed", () => CODE_BLOCK_WRAPPERS.delete(wrapper));

    const header = new BoxRenderable(ctx, {
      flexDirection: "row",
      width: "100%",
      paddingLeft: 1,
      paddingRight: 1,
    });

    const labelText = new TextRenderable(ctx, {
      content: lang.toUpperCase(),
      fg: currentMarkdownTheme.codeLabelFg,
    });

    const spacer = new BoxRenderable(ctx, { flexGrow: 1 });

    const copyText = new TextRenderable(ctx, {
      content: "copy",
      fg: currentMarkdownTheme.codeCopyFg,
    });

    header.add(labelText);
    header.add(spacer);
    header.add(copyText);

    const codeContainer = new BoxRenderable(ctx, {
      paddingLeft: 1,
      paddingRight: 1,
      width: "100%",
    });
    codeContainer.add(codeText);

    wrapper.add(header);
    wrapper.add(codeContainer);

    wrapper[INNER_TEXT] = codeText;
    wrapper[LABEL_REF] = labelText;
    wrapper[COPY_REF] = copyText;
    wrapper[CODE_CONTENT] = rawContent;

    wrapper.onMouseOver = () => {
      wrapper.borderColor = currentMarkdownTheme.codeBorderHover;
      copyText.fg = currentMarkdownTheme.codeLabelFg;
    };
    wrapper.onMouseOut = () => {
      wrapper.borderColor = currentMarkdownTheme.codeBorder;
      copyText.fg = currentMarkdownTheme.codeCopyFg;
    };

    wrapper.onMouseDown = () => {
      const raw = wrapper[CODE_CONTENT];
      if (!raw) return;
      void clipboard.writeText(raw).then((ok) => {
        if (!ok) return;
        copyText.content = "copied!";
        copyText.fg = currentMarkdownTheme.codeCopyFlash;
        setTimeout(() => {
          copyText.content = "copy";
          copyText.fg = currentMarkdownTheme.codeCopyFg;
        }, 1500);
      });
    };

    return wrapper;
  }

  proto.createCodeRenderable = function createCodeRenderablePatched(
    token: Tokens.Code,
    id: string,
    marginBottom: number = 0,
  ) {
    const filetype = inferCodeFiletype(token.text, token.lang ?? "");
    const initialChunks = filetype ? fallbackCodeChunks([], {
      content: token.text,
      filetype,
      highlights: [],
    }) : null;
    const initialStyledText = initialChunks && initialChunks.length > 0
      ? new StyledText(initialChunks)
      : undefined;
    const codeText = new CodeRenderable(this.ctx, {
      id,
      content: token.text,
      filetype,
      syntaxStyle: this._syntaxStyle as any,
      fg: this._fg,
      bg: this._bg,
      conceal: this._concealCode,
      // 首帧使用同步快照；收到后续 token 后清除快照，Tree-sitter 处理期间保留上一份 styled buffer。
      drawUnstyledText: true,
      initialStyledText,
      streaming: this._streaming,
      onChunks: fallbackCodeChunks,
      treeSitterClient: this._treeSitterClient as any,
      width: "100%",
    });

    return buildCodeBlockWrapper(
      this.ctx,
      codeText,
      token.text,
      filetype || token.lang || "text",
      marginBottom,
    );
  };

  proto.applyMarkdownCodeRenderable = function applyMarkdownCodeRenderablePatched(
    renderable: InstanceType<typeof CodeRenderable>,
    content: string,
    marginBottom: number,
    baseHighlight?: string,
    initialStyledText?: any,
  ): void {
    renderable.initialStyledText = initialStyledText;
    renderable.content = content;
    renderable.filetype = "markdown";
    renderable.syntaxStyle = this._syntaxStyle as any;
    renderable.fg = this._fg;
    renderable.bg = this._bg;
    renderable.conceal = this._conceal;
    // 0.4.1: draw raw text only while the precomputed styled text is present.
    renderable.drawUnstyledText = initialStyledText !== undefined;
    // : per-width height floor — follows the explicit reserve flag when set
    // (lets completed entries disable it), else falls back to streaming.
    renderable.reserveHeightWhileStreaming = this._reserveHeightWhileStreaming ?? this._streaming;
    renderable.streaming = true;
    renderable.baseHighlight = baseHighlight;
    const synthetic = createMarkdownSyntheticBlockHighlighter(() => this._treeSitterClient);
    renderable.onHighlight = (highlights: any, context: any) =>
      FRONT_MATTER_OPENER_RE.test(context.content) ? synthetic(highlights, context) : undefined;
    renderable.onChunks = (chunks: TextChunk[], context: any) => {
      try {
        const transformed = this._linkifyMarkdownChunks(chunks, context);
        if (transformed && typeof transformed.then === "function") return chunks;
        return transformed ?? chunks;
      } catch {
        return chunks;
      }
    };
    renderable.treeSitterClient = this._treeSitterClient as any;
    renderable.marginBottom = marginBottom;
  };

  proto.applyCodeBlockRenderable = function applyCodeBlockRenderablePatched(
    renderable: any,
    token: Tokens.Code,
    marginBottom: number,
  ): void {
    refreshCodeBlockTheme(renderable);
    const inner: InstanceType<typeof CodeRenderable> | undefined = renderable[INNER_TEXT];
    if (inner) {
      inner.initialStyledText = undefined;
      inner.filetype = inferCodeFiletype(token.text, token.lang ?? "");
      inner.syntaxStyle = this._syntaxStyle as any;
      inner.fg = this._fg;
      inner.bg = this._bg;
      inner.conceal = this._concealCode;
      inner.drawUnstyledText = !this._streaming;
      inner.streaming = this._streaming;
      inner.onChunks = fallbackCodeChunks;
      inner.treeSitterClient = this._treeSitterClient as any;
      inner.content = token.text;
      renderable[CODE_CONTENT] = token.text;
    }

    const label: InstanceType<typeof TextRenderable> | undefined = renderable[LABEL_REF];
    if (label) {
      label.content = (inferCodeFiletype(token.text, token.lang ?? "") || token.lang || "text").toUpperCase();
    }

    const copy: InstanceType<typeof TextRenderable> | undefined = renderable[COPY_REF];
    if (copy) copy.fg = currentMarkdownTheme.codeCopyFg;

    renderable.marginBottom = marginBottom;
  };
}
