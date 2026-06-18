import {
  File,
  FileCode,
  FileCode2,
  FileJson,
  FileText,
  FileType,
  type LucideIcon,
} from 'lucide-react'

/**
 * Map a filename to a lucide icon based on extension. Used in both the
 * transcript's file-edit cards and the right-pane Files panel for visual
 * consistency.
 */
export function iconForExtension(filename: string): LucideIcon {
  const i = filename.lastIndexOf('.')
  if (i < 0) return File
  const ext = filename.slice(i + 1).toLowerCase()
  switch (ext) {
    case 'json':
    case 'jsonc':
      return FileJson
    case 'md':
    case 'mdx':
    case 'txt':
    case 'rst':
      return FileText
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return FileCode
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return FileCode2
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
    case 'html':
    case 'htm':
    case 'svg':
    case 'xml':
      return FileType
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cc':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'yaml':
    case 'yml':
    case 'toml':
      return FileCode
    default:
      return File
  }
}
