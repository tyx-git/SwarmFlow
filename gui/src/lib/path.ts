/**
 * Path / display helpers shared by transcript, sidebar, status bar, etc.
 */

const HOME_RE = /\/Users\/[a-zA-Z0-9._-]+/g

/** Replace any `/Users/<user>` prefix with `~`. */
export function withTilde(s: string): string {
  return s.replace(HOME_RE, '~')
}

/**
 * Shorten an absolute path against a workspace root. Falls back to `~/...`
 * when no workspace prefix matches.
 */
export function relToWorkspace(path: string, workDir: string | null | undefined): string {
  if (!workDir) return withTilde(path)
  const norm = (p: string): string => p.replace(/\/+$/, '')
  const wd = norm(workDir)
  if (path === wd) return '.'
  if (path.startsWith(wd + '/')) {
    return path.slice(wd.length + 1)
  }
  return withTilde(path)
}

/**
 * Best-effort path-shortening for free-form summary strings (e.g.
 * tool-call display lines). Replaces any `/Users/<user>` prefix with `~`,
 * collapses consecutive whitespace.
 */
export function shortenSummary(s: string, workDir?: string | null): string {
  let out = s
  if (workDir) {
    const wd = workDir.replace(/\/+$/, '')
    out = out.split(wd + '/').join('')
    if (out === wd) out = '.'
  }
  out = withTilde(out)
  return out.replace(/\s+/g, ' ')
}

/**
 * Project-name slug for a workspace root: take the last path segment.
 */
export function projectName(workDir: string): string {
  const segs = workDir.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? workDir
}

/**
 * Title-bar style: "…/parent/leaf" form for display in tight contexts.
 */
export function shortPath(p: string): string {
  const segs = p.split('/').filter(Boolean)
  if (segs.length <= 3) return p
  return '…/' + segs.slice(-2).join('/')
}
