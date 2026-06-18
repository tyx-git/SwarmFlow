/**
 * Lazy Shiki highlighter. Loads themes/languages on demand and caches
 * a singleton so subsequent calls are cheap.
 */

import type { Highlighter, BundledLanguage, BundledTheme } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()
const loadedThemes = new Set<string>()

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import('shiki')
      return createHighlighter({
        themes: ['github-dark-default', 'github-light-default'],
        langs: ['javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'shell', 'css', 'html', 'markdown'],
      })
    })()
  }
  return highlighterPromise
}

const ALIASES: Record<string, BundledLanguage> = {
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  go: 'go',
}

export async function highlightCode(code: string, lang: string): Promise<string | null> {
  if (!code) return null
  const resolved = (ALIASES[lang.toLowerCase()] ?? lang) as BundledLanguage
  try {
    const h = await getHighlighter()
    if (!loadedLangs.has(resolved)) {
      try {
        await h.loadLanguage(resolved as never)
        loadedLangs.add(resolved)
      } catch {
        return null
      }
    }
    const isDark = document.documentElement.classList.contains('dark')
    const theme: BundledTheme = isDark ? 'github-dark-default' : 'github-light-default'
    if (!loadedThemes.has(theme)) {
      try {
        await h.loadTheme(theme as never)
        loadedThemes.add(theme)
      } catch {
        return null
      }
    }
    // codeToHtml wraps in <pre><code>; we want just the inner highlighted spans
    // so we strip those wrappers and return only the children of <code>.
    const html = h.codeToHtml(code, { lang: resolved, theme })
    const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return match ? (match[1] ?? null) : null
  } catch {
    return null
  }
}
