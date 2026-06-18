/**
 * Lightweight markdown renderer using `marked` with default rendering.
 *
 * Styling is applied via descendant CSS selectors in globals.css under
 * `.markdown-body`. Code blocks get post-render Shiki highlighting which
 * is folded back into the rendered HTML so that subsequent re-renders
 * (very frequent during streaming) don't wipe the highlights.
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

  // Cache: theme|codeText|lang -> highlighted innerHTML. Including the
  // theme in the key invalidates cached highlights on theme switch.
  const [highlightCache, setHighlightCache] = useState<Map<string, string>>(
    () => new Map(),
  )

  // Build the final HTML by replacing each <pre><code> with its highlighted
  // version (if cached). Unhighlighted blocks render plain until Shiki
  // resolves and triggers a re-render.
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

  // After render, find any unhighlighted code blocks and request highlighting.
  // Results go into `highlightCache` which triggers a re-render.
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
