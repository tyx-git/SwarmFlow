/**
 * 惰性 Shiki 高亮器。按需加载主题/语言，并缓存单例，
 * 以便后续调用代价低廉。
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
    // codeToHtml 用 <pre><code> 包装；我们只想要内部高亮的 span，
    // 所以去掉包装并只返回 <code> 的子元素。
    const html = h.codeToHtml(code, { lang: resolved, theme })
    const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return match ? (match[1] ?? null) : null
  } catch {
    return null
  }
}
