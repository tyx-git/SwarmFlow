/**
 * 使用 `marked` 的轻量级 markdown 渲染器，默认渲染。
 *
 * 样式通过 globals.css 中的后代 CSS 选择器应用于 `.markdown-body`。
 * 代码块在渲染后获得 Shiki 高亮，然后合并回渲染后的 HTML，
 * 以便后续重新渲染（流式传输时非常频繁）不会清除高亮。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { cn } from '@/lib/cn.js'
import { highlightCode } from '@/lib/shiki.js'
import { useSessionStore } from '@/state/sessionStore.js'

marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
})

const CODE_BLOCK_RE = /<pre><code class="language-([a-zA-Z0-9_+-]+)">([\s\S]*?)<\/code><\/pre>/g

export function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}): JSX.Element {
  const baseHtml = useMemo(() => {
    try {
      return marked.parse(text, { async: false }) as string
    } catch {
      return escape(text)
    }
  }, [text])

  const theme = useSessionStore((s) => s.theme)

  // 缓存：theme|codeText|lang -> 高亮的 innerHTML。
  // 将 theme 包含在 key 中会在主题切换时使缓存的高亮失效。
  const [highlightCache, setHighlightCache] = useState<Map<string, string>>(
    () => new Map(),
  )

  // 通过将每个 <pre><code> 替换为高亮版本（如果已缓存）来构建最终 HTML。
  // 未高亮的块会先以纯文本形式渲染，直到 Shiki 解析完毕并触发重新渲染。
  const html = useMemo(() => {
    return baseHtml.replace(
      CODE_BLOCK_RE,
      (match, lang: string, body: string) => {
        const decoded = decodeHtml(body).replace(/\n$/, '')
        const cached = highlightCache.get(`${theme}|${lang}|${decoded}`)
        if (cached) {
          return `<pre><code class="language-${lang}" data-highlighted="1">${cached}</code></pre>`
        }
        return match
      },
    )
  }, [baseHtml, highlightCache, theme])

  // 渲染后，找到所有未高亮的代码块并请求高亮。
  // 结果进入 `highlightCache`，触发重新渲染。
  useEffect(() => {
    const matches = [...baseHtml.matchAll(CODE_BLOCK_RE)]
    if (matches.length === 0) return
    const pending = matches.filter((m) => {
      const lang = m[1] ?? 'text'
      const decoded = decodeHtml(m[2] ?? '').replace(/\n$/, '')
      return !highlightCache.has(`${theme}|${lang}|${decoded}`)
    })
    if (pending.length === 0) return
    let stillMounted = true
    void Promise.all(
      pending.map(async (m) => {
        const lang = m[1] ?? 'text'
        const decoded = decodeHtml(m[2] ?? '').replace(/\n$/, '')
        const key = `${theme}|${lang}|${decoded}`
        try {
          const highlighted = await highlightCode(decoded, lang)
          if (!stillMounted || !highlighted) return null
          return [key, highlighted] as const
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (!stillMounted) return
      const updates = results.filter((r): r is readonly [string, string] => r !== null)
      if (updates.length === 0) return
      setHighlightCache((prev) => {
        const next = new Map(prev)
        for (const [k, v] of updates) next.set(k, v)
        return next
      })
    })
    return () => {
      stillMounted = false
    }
  }, [baseHtml, highlightCache, theme])

  const rootRef = useRef<HTMLDivElement>(null)

  // Attach a "Copy" button overlay to each <pre> code block after render.
  // Code blocks are dangerouslySetInnerHTML so we inject post-render via DOM.
  // CSS lives in globals.css (.markdown-body .md-copy-btn) so styles persist
  // across re-renders that wipe inline className strings.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const pres = root.querySelectorAll<HTMLPreElement>('pre:not([data-copy-attached])')
    pres.forEach((pre) => {
      pre.setAttribute('data-copy-attached', '1')
      pre.classList.add('md-pre')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.setAttribute('aria-label', 'Copy code block')
      btn.className = 'md-copy-btn'
      btn.addEventListener('click', (event) => {
        event.preventDefault()
        const codeNode = pre.querySelector('code')
        const text = (codeNode?.textContent ?? pre.textContent ?? '').replace(/\s+$/, '')
        if (!text) return
        void navigator.clipboard.writeText(text).then(
          () => {
            btn.textContent = 'Copied'
            window.setTimeout(() => {
              btn.textContent = 'Copy'
            }, 1400)
          },
          () => {
            btn.textContent = 'Failed'
            window.setTimeout(() => {
              btn.textContent = 'Copy'
            }, 1400)
          },
        )
      })
      pre.appendChild(btn)
    })
    // Re-run on every render — dangerouslySetInnerHTML wipes child DOM even
    // when `html` is unchanged (object identity differs), so we need to
    // re-attach. The `:not([data-copy-attached])` selector keeps it cheap
    // when the buttons survived.
  })

  return (
    <div
      ref={rootRef}
      className={cn('markdown-body', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
