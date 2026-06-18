/**
 * Transcript: document-style rendering matching the design template.
 *
 * - User messages → right-aligned neutral bubble
 * - Reasoning → "✦ Thought for Xs" header + dim body
 * - Assistant text → document prose with markdown
 * - Tool calls → prefix-labeled rows (Q_ grep, $_ bash, ✎_ edit, etc.)
 *   with expandable result body
 * - File edits → inline pill chips with +/- counts
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  File,
  FileCode,
  FileCode2,
  FileJson,
  FilePenLine,
  FilePlus,
  FileText,
  FileType,
  Copy,
  Check,
  Search,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { Markdown } from '@/components/Markdown.js'
import { shortenSummary } from '@/lib/path.js'
import { DiffView } from '@/components/DiffView.js'
import { iconForExtension } from '@/lib/fileIcon.js'

interface LogEntry {
  id: string
  type: string
  turnIndex?: number
  display?: string
  tuiVisible?: boolean
  discarded?: boolean
  meta?: Record<string, unknown>
  content?: unknown
}

interface ToolCallEntry extends LogEntry { type: 'tool_call' }
interface ToolResultEntry extends LogEntry { type: 'tool_result' }

export interface TranscriptRewindTarget {
  readonly turnIndex: number
  readonly preview: string
}

export function Transcript({
  entries,
  activeId,
  workDir,
  markdownMode,
  emptyLabel = 'Ready',
  canRewind = false,
  onRequestRewind,
}: {
  entries: unknown[]
  activeId: string | null
  workDir?: string
  markdownMode: 'rendered' | 'raw'
  emptyLabel?: string | null
  canRewind?: boolean
  onRequestRewind?: (target: TranscriptRewindTarget) => void
}): JSX.Element {
  const items = useMemo(() => {
    const arr = entries as LogEntry[]
    const visible = arr.filter((e) => !e.discarded && e.tuiVisible !== false)
    const resultByCallId = new Map<string, ToolResultEntry>()
    for (const e of visible) {
      if (e.type === 'tool_result') {
        const callId = (e.meta as Record<string, unknown> | undefined)?.['toolCallId']
        if (typeof callId === 'string') resultByCallId.set(callId, e as ToolResultEntry)
      }
    }
    type ToolPair = { call: ToolCallEntry; result: ToolResultEntry | null }
    type Item =
      | { kind: 'entry'; entry: LogEntry }
      | { kind: 'tool'; call: ToolCallEntry; result: ToolResultEntry | null }
      | { kind: 'reasoning'; entries: LogEntry[] }
      | { kind: 'explore'; pairs: ToolPair[] }

    const out: Item[] = []
    for (const e of visible) {
      if (e.type === 'tool_call') {
        const callId = (e.meta as Record<string, unknown> | undefined)?.['toolCallId']
        const result = typeof callId === 'string' ? resultByCallId.get(callId) ?? null : null
        const toolName = getToolName(e)
        const pair: ToolPair = { call: e as ToolCallEntry, result }

        if (isExploreTool(toolName)) {
          const last = out[out.length - 1]
          if (last && last.kind === 'explore') {
            last.pairs.push(pair)
          } else {
            out.push({ kind: 'explore', pairs: [pair] })
          }
        } else {
          out.push({ kind: 'tool', ...pair })
        }
      } else if (e.type === 'tool_result') {
        // rendered with its call
      } else if (e.type === 'reasoning') {
        const last = out[out.length - 1]
        if (last && last.kind === 'reasoning') {
          last.entries.push(e)
        } else {
          out.push({ kind: 'reasoning', entries: [e] })
        }
      } else {
        out.push({ kind: 'entry', entry: e })
      }
    }
    return out
  }, [entries])

  if (items.length === 0) {
    return (
      <div data-transcript-root className="flex h-full items-center justify-center">
        {emptyLabel && <div className="text-[15px] text-ink-3">{emptyLabel}</div>}
      </div>
    )
  }

  return (
    <div data-transcript-root className="px-6 py-6">
      <div data-transcript-shell className="mx-auto max-w-[840px]">
        {items.map((item) => {
          if (item.kind === 'reasoning') {
            const lastEntry = item.entries[item.entries.length - 1]!
            const active = lastEntry.id === activeId
            const combined = item.entries.map((e) => e.display ?? '').filter(Boolean).join('\n')
            return <ThoughtBlock key={item.entries[0]!.id} text={combined} active={active} />
          }
          if (item.kind === 'explore') {
            // Single explore tool → render as plain dim text line (same as grouped items)
            if (item.pairs.length === 1) {
              const p = item.pairs[0]!
              return (
                <ExploreItem
                  key={p.call.id}
                  call={p.call}
                  result={p.result}
                  workDir={workDir}
                />
              )
            }
            return (
              <ExploreGroup
                key={item.pairs[0]!.call.id}
                pairs={item.pairs}
                workDir={workDir}
              />
            )
          }
          if (item.kind === 'tool') {
            const active = item.call.id === activeId
            const toolName = getToolName(item.call)
            const isFileModify = toolName === 'write_file' || toolName === 'edit_file'
            if (isFileModify) {
              return (
                <FileEditPill
                  key={item.call.id}
                  call={item.call}
                  result={item.result}
                  active={active}
                  workDir={workDir}
                />
              )
            }
            return (
              <ToolRow
                key={item.call.id}
                call={item.call}
                result={item.result}
                active={active}
                workDir={workDir}
              />
            )
          }
          return (
            <EntryRow
              key={item.entry.id}
              entry={item.entry}
              active={item.entry.id === activeId}
              markdownMode={markdownMode}
              canRewind={canRewind}
              onRequestRewind={onRequestRewind}
            />
          )
        })}
      </div>
    </div>
  )
}

function EntryRow({
  entry,
  active,
  markdownMode,
  canRewind,
  onRequestRewind,
}: {
  entry: LogEntry
  active: boolean
  markdownMode: 'rendered' | 'raw'
  canRewind: boolean
  onRequestRewind?: (target: TranscriptRewindTarget) => void
}): JSX.Element {
  const display = getEntryText(entry)
  switch (entry.type) {
    case 'user_message':
      return (
        <UserBubble
          text={display}
          turnIndex={entry.turnIndex}
          canRewind={canRewind}
          onRequestRewind={onRequestRewind}
        />
      )
    case 'assistant_text':
      return <AssistantText text={display} active={active} markdownMode={markdownMode} />
    case 'reasoning':
      // Handled by the reasoning-merge logic above; should not reach here.
      return <></>

    case 'agent_result':
      return <AssistantText text={display} active={false} markdownMode={markdownMode} />
    case 'sub_agent_start':
    case 'sub_agent_end':
    case 'sub_agent_tool_call':
      return <SubAgentRow text={display} />
    case 'compact_marker':
      return <CompactMarker text={display} />
    case 'status':
      return <StatusRow text={display} />
    case 'error':
      return <ErrorRow text={display} />
    case 'interruption_marker':
      return <InterruptedRow text={display} />
    case 'turn_start':
    case 'turn_end':
    case 'input_received':
    case 'work_end':
    case 'no_reply':
    case 'token_update':
    case 'system_prompt':
    case 'ask_request':
    case 'ask_resolution':
      return <></>
    default:
      return <div className="mono text-[15px] text-ink-4">[{entry.type}] {display}</div>
  }
}

/* ── User message bubble (neutral, right-aligned) ── */

function UserBubble({
  text,
  turnIndex,
  canRewind,
  onRequestRewind,
}: {
  text: string
  turnIndex?: number
  canRewind: boolean
  onRequestRewind?: (target: TranscriptRewindTarget) => void
}): JSX.Element {
  const rewindable = canRewind && typeof turnIndex === 'number' && onRequestRewind
  return (
    <div className="group/message my-3.5 flex items-start justify-end gap-2">
      {rewindable && (
        <MessageRewindButton
          turnIndex={turnIndex}
          preview={text}
          onRequestRewind={onRequestRewind}
        />
      )}
      <MessageCopyButton text={text} label="Copy message" align="left" />
      <div
        className="max-w-[72%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-[15.5px] leading-[1.55]"
        style={{ background: 'var(--color-bubble)', color: 'var(--color-bubble-ink)' }}
      >
        {text}
      </div>
    </div>
  )
}

function MessageRewindButton({
  turnIndex,
  preview,
  onRequestRewind,
}: {
  turnIndex: number
  preview: string
  onRequestRewind: (target: TranscriptRewindTarget) => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onRequestRewind({ turnIndex, preview })}
      aria-label="Rewind before this message"
      title="Rewind before this message"
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded text-ink-4 opacity-0 transition',
        'hover:bg-line-soft hover:text-ink focus-visible:opacity-100',
        'group-hover/message:opacity-100',
      )}
    >
      <Undo2 className="h-3.5 w-3.5" strokeWidth={1.7} />
    </button>
  )
}

/* ── Thought block: one "✦ Thinking" header per consecutive reasoning run ── */

function ThoughtBlock({ text, active }: { text: string; active: boolean }): JSX.Element {
  const [open, setOpen] = useState(active)
  // Auto-collapse when thinking finishes (active goes false)
  const prevActive = useRef(active)
  if (prevActive.current && !active) {
    // Was active, now done — will collapse on next render
  }
  useEffect(() => {
    if (prevActive.current && !active) setOpen(false)
    prevActive.current = active
  }, [active])
  // Auto-open when active
  useEffect(() => {
    if (active) setOpen(true)
  }, [active])

  if (!text.trim()) return <></>
  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex min-h-7 items-center gap-1.5 rounded-md text-[14.5px] transition hover:bg-line-soft/40"
      >
        <ChevronRight
          className={cn('h-3 w-3 text-ink-4 transition-transform', open && 'rotate-90')}
          strokeWidth={2}
        />
        <span className={cn('font-medium', active ? 'shimmer-text text-ink-2' : 'text-ink-3 group-hover:text-ink-2')}>
          Thinking
        </span>
      </button>
      {open && (
        <div
          className={cn(
            'mt-1 ml-1 border-l-2 border-line-soft pl-3 text-[14.5px] leading-[1.6] text-ink-4 whitespace-pre-wrap',
            active && 'shimmer-text border-accent/40',
          )}
        >
          {renderThoughtText(text)}
        </div>
      )}
    </div>
  )
}

function renderThoughtText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(<strong key={key++} className="font-semibold">{match[1]}</strong>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/* ── Assistant text (document prose with markdown) ── */

function AssistantText({
  text,
  active,
  markdownMode,
}: {
  text: string
  active: boolean
  markdownMode: 'rendered' | 'raw'
}): JSX.Element {
  if (!text.trim()) return <></>
  if (markdownMode === 'raw') {
    return (
      <div className="group/message relative my-2">
        <MessageCopyButton text={text} label="Copy response" align="right" />
        <div
          className={cn(
            'mono whitespace-pre-wrap pr-9 text-[14.5px] leading-[1.65] text-ink-2',
            active && 'shimmer-text',
          )}
        >
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className="group/message relative my-2">
      <MessageCopyButton text={text} label="Copy response" align="right" />
      <Markdown text={text} className={cn(active && 'shimmer-text')} />
    </div>
  )
}

function MessageCopyButton({
  text,
  label,
  align,
}: {
  text: string
  label: string
  align: 'left' | 'right'
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const disabled = !text.trim()

  const copy = async (): Promise<void> => {
    if (disabled) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1100)
    } catch (err) {
      console.error('copy message failed', err)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={disabled}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded text-ink-4 opacity-0 transition',
        'hover:bg-line-soft hover:text-ink focus-visible:opacity-100',
        'group-hover/message:opacity-100',
        align === 'right' && 'absolute right-0 top-0',
        disabled && 'pointer-events-none',
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/* ── Tool row (prefix-labeled: Q_, $_, %_, ✎_) ── */

function ToolRow({
  call,
  result,
  active,
  workDir,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  active: boolean
  workDir?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const toolName = getToolName(call)
  const display = call.display ?? toolName
  const space = display.indexOf(' ')
  const cmd = space > 0 ? display.slice(space + 1) : display
  const prefix = pickPrefix(toolName)

  const resultContent = result?.content as { content?: string } | undefined
  const resultText = resultContent?.content ?? result?.display ?? ''
  const isError = (result?.meta as Record<string, unknown> | undefined)?.['isError'] === true
  const running = active || !result
  const canExpand = !!result && resultText.trim().length > 0

  return (
    <div className="my-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => canExpand && setOpen(!open)}
        disabled={!canExpand && !running}
        className={cn(
          'flex w-full items-center gap-2.5 rounded border px-3 py-2 text-left transition',
          'border-line-soft bg-code-bg',
          canExpand && 'cursor-pointer hover:border-line',
        )}
      >
        <span className="mono w-3.5 shrink-0 text-center text-[14px] text-ink-3">
          {running ? <span className="working-spinner" /> : prefix}
        </span>
        <span
          className={cn(
            'mono flex-1 truncate text-[15px] leading-[1.4]',
            running ? 'shimmer-text' : 'text-code-ink',
          )}
        >
          {shortenSummary(cmd, workDir)}
        </span>
        {canExpand && (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-ink-4 transition-transform',
              open && 'rotate-90',
            )}
            strokeWidth={2}
          />
        )}
      </button>
      {open && result && (
        <div
          className={cn(
            'group/output relative my-1 rounded border border-line-soft bg-code-bg',
            isError && 'border-error/30',
          )}
        >
          <div
            className={cn(
              'mono px-3.5 py-3 text-[13.5px] leading-[1.6] text-ink-2',
              'max-h-[400px] overflow-auto whitespace-pre',
              isError && 'text-error',
            )}
          >
            {truncateResult(resultText)}
          </div>
          <button
            type="button"
            onClick={async (event) => {
              event.stopPropagation()
              try {
                await navigator.clipboard.writeText(truncateResult(resultText))
              } catch { /* */ }
            }}
            title="Copy output"
            aria-label="Copy output"
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md border border-line-soft bg-pane-2 text-ink-3 opacity-0 transition hover:border-line hover:text-ink group-hover/output:opacity-100"
          >
            <Copy className="h-3 w-3" strokeWidth={1.7} />
          </button>
        </div>
      )}
    </div>
  )
}

/* ── File edit pill (inline chip with +/- counts) ── */

function FileEditPill({
  call,
  result,
  active,
  workDir,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  active: boolean
  workDir?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const toolName = getToolName(call)
  const isWrite = toolName === 'write_file'
  const display = call.display ?? ''
  const space = display.indexOf(' ')
  const path = space > 0 ? display.slice(space + 1) : display
  const shortPath = shortenSummary(path, workDir)
  const basename = path.split('/').filter(Boolean).pop() ?? path

  const resultDisplay = result?.display ?? ''
  const resultContent = result?.content as { content?: string } | undefined
  const resultText = (resultContent?.content ?? '').replace(/\s*\[mtime_ms=\d+\]/g, '')
  const isError = (result as { isError?: boolean } | null)?.isError === true

  const diffLines = resultDisplay.split('\n')
  const actualAdds = diffLines.filter((l) => /^\s*\d+\s+\+/.test(l)).length
  const actualDels = diffLines.filter((l) => /^\s*\d+\s+-/.test(l)).length

  // Detect "new file" from result text or write_file with no existing target.
  const isNew = isWrite && /^new file/i.test(resultText.trim()) || actualDels === 0 && isWrite

  const HeaderIcon = isNew ? FilePlus : FilePenLine
  const headerLabel = isNew ? 'Created' : isWrite ? 'Overwrote' : 'Edited'
  const FileIcon = iconForExtension(basename)

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-xl border bg-code-bg',
        isError ? 'border-error/40' : active ? 'border-accent/40' : 'border-line-soft',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2 text-left transition',
          'hover:bg-line-soft/40',
        )}
      >
        <span
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-md',
            isNew ? 'bg-success/10 text-success' : 'bg-accent/10 text-accent',
          )}
        >
          <HeaderIcon className="h-3.5 w-3.5" strokeWidth={1.7} />
        </span>
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-4">
          {headerLabel}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13.5px]">
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={1.6} />
          <span className="mono truncate font-medium text-ink">{basename}</span>
          {shortPath && shortPath !== basename && (
            <span className="mono ml-1 truncate text-[12px] text-ink-4">{shortPath}</span>
          )}
        </span>
        <span className="mono flex shrink-0 items-center gap-1.5 text-[13px]">
          {actualAdds > 0 && <span className="text-diff-add-ink">+{actualAdds}</span>}
          {actualDels > 0 && <span className="text-diff-rm-ink">−{actualDels}</span>}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform', !expanded && '-rotate-90')}
          strokeWidth={1.8}
        />
      </button>
      {expanded && result && resultDisplay && (
        <div className="border-t border-line-soft/60">
          <DiffView
            text={resultDisplay}
            workDir={workDir}
            isError={isError}
            resultSummary={resultText && resultText !== resultDisplay ? resultText : undefined}
            hideHeader
            flush
          />
        </div>
      )}
    </div>
  )
}

/* ── Misc rows ── */

function SubAgentRow({ text }: { text: string }): JSX.Element {
  return <div className="mono my-0.5 text-[15.5px] text-ink-3">{text}</div>
}

function CompactMarker({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-3 text-center text-[12.5px] text-ink-4">
      {text || 'Compacted'}
    </div>
  )
}

function StatusRow({ text }: { text: string }): JSX.Element {
  return <div className="text-center text-[15.5px] italic text-ink-4">{text}</div>
}

function ErrorRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-1.5 flex items-start gap-2 rounded border border-error/30 bg-error/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
      <div className="flex-1 text-[16px] text-error whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function InterruptedRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-3 text-center text-[12.5px] text-ink-3">
      {text || 'Interrupted'}
    </div>
  )
}

/* ── Helpers ── */

/* ── Explore group: consecutive read-only tools bundled ── */

const EXPLORE_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch'])

function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name)
}

const EXPLORE_DISPLAY: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Search',
  web_search: 'Search',
  web_fetch: 'Fetch',
}

const EXPLORE_UNIT: Record<string, string> = {
  Read: 'file',
  List: 'dir',
  Glob: 'pattern',
  Search: 'query',
  Fetch: 'page',
}

function exploreDisplayName(toolName: string): string {
  return EXPLORE_DISPLAY[toolName] ?? 'Op'
}

function exploreUnit(name: string, count: number): string {
  const singular = EXPLORE_UNIT[name] ?? 'op'
  if (count === 1) return singular
  if (singular.endsWith('y')) return singular.slice(0, -1) + 'ies'
  return singular + 's'
}

function ExploreGroup({
  pairs,
  workDir,
}: {
  pairs: Array<{ call: ToolCallEntry; result: ToolResultEntry | null }>
  workDir?: string
}): JSX.Element {
  const running = pairs.some((p) => !p.result)
  const [open, setOpen] = useState(running)
  const prevRunning = useRef(running)

  useEffect(() => {
    if (running) {
      setOpen(true)
    } else if (prevRunning.current) {
      setOpen(false)
    }
    prevRunning.current = running
  }, [running])

  // Count by display name (matching TUI: Read/List/Glob/Search)
  const counts = new Map<string, number>()
  for (const p of pairs) {
    const tn = ((p.call.meta as Record<string, unknown> | undefined)?.['toolName'] as string) ?? ''
    const name = exploreDisplayName(tn)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const summary = [...counts.entries()]
    .map(([name, count]) => `${name} ${count} ${exploreUnit(name, count)}`)
    .join(', ')

  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex w-full min-h-7 items-center gap-2 rounded-md py-1 pl-0.5 pr-1 text-left transition hover:bg-line-soft/40"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-line-soft/70 text-ink-3 transition group-hover:text-ink">
          <Search className="h-3 w-3" strokeWidth={2} />
        </span>
        <span className="text-[14.5px] font-medium text-ink-2">Explore</span>
        <span className="truncate text-[13.5px] text-ink-4">{summary}</span>
        <ChevronRight
          className={cn('ml-auto h-3 w-3 shrink-0 text-ink-4 transition-transform', open && 'rotate-90')}
          strokeWidth={2}
        />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0 border-l border-line-soft/70 pl-3">
          {pairs.map((p) => (
            <ExploreItem key={p.call.id} call={p.call} result={p.result} workDir={workDir} dense />
          ))}
        </div>
      )}
    </div>
  )
}

function ExploreItem({
  call,
  result,
  workDir,
  dense = false,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  workDir?: string
  dense?: boolean
}): JSX.Element {
  const toolName = getToolName(call)
  const display = call.display ?? toolName
  const isError = (result?.meta as Record<string, unknown> | undefined)?.['isError'] === true

  const verb = exploreDisplayName(toolName) // "Read" / "List" / "Glob" / "Search"
  const desc = formatExploreDesc(toolName, display, workDir)
  // Try to strip the leading verb from desc to avoid duplication.
  const stripped = desc.replace(new RegExp(`^${verb}\\s+`, 'i'), '')

  return (
    <div
      className={cn(
        'group flex items-baseline gap-2 leading-[1.55] text-ink-3',
        dense ? 'py-0.5' : 'my-2',
      )}
    >
      <span className="mono shrink-0 text-[11.5px] uppercase tracking-wide text-ink-4">
        {verb}
      </span>
      <span className={cn('mono min-w-0 flex-1 truncate text-[13px]', isError ? 'text-error' : 'text-ink-2')}>
        {stripped}
        {isError && ' · failed'}
      </span>
    </div>
  )
}

function getToolName(entry: LogEntry): string {
  const meta = entry.meta as Record<string, unknown> | undefined
  const metaName = meta?.['toolName']
  if (typeof metaName === 'string' && metaName.length > 0) return metaName

  const content = entry.content as { name?: unknown; toolName?: unknown } | undefined
  if (typeof content?.name === 'string' && content.name.length > 0) return content.name
  if (typeof content?.toolName === 'string' && content.toolName.length > 0) return content.toolName

  return 'tool'
}

function getEntryText(entry: LogEntry): string {
  if (typeof entry.display === 'string') return entry.display
  if (typeof entry.content === 'string') return entry.content
  return ''
}

function formatExploreDesc(toolName: string, display: string, workDir?: string): string {
  const cleaned = shortenSummary(display, workDir)
  // Strip the tool name prefix from display since we add our own verb
  const space = cleaned.indexOf(' ')
  const args = space > 0 ? cleaned.slice(space + 1) : cleaned

  switch (toolName) {
    case 'read_file': {
      // "read_file path" → "Read path"
      // Parse line range if present: "Read file L1-50"
      return `Read ${args}`
    }
    case 'list_dir':
      return `Listed ${args || '.'}`
    case 'glob':
      return `Glob ${args}`
    case 'grep':
      return `Grepped ${args}`
    case 'web_search':
      return `Searched ${args}`
    case 'web_fetch':
      return `Fetched ${args}`
    default:
      return cleaned
  }
}

function pickPrefix(name: string): string {
  if (name === 'grep') return 'Q'
  if (name === 'bash' || name === 'bash_background') return '$'
  if (name === 'edit_file') return '✎'
  if (name === 'write_file') return '+'
  if (name === 'read_file') return '◇'
  if (name === 'list_dir' || name === 'glob') return '⌕'
  if (name === 'web_search' || name === 'web_fetch') return '⊕'
  return '›'
}

function truncateResult(text: string): string {
  // Strip read_file metadata headers like "[Lines 1-25 of 25 | mtime_ms=... | size_bytes=...]"
  let cleaned = text.replace(/^\[Lines? \d+-\d+ of \d+[^\]]*\]\n?/gm, '')
  // Strip write_file result summaries
  cleaned = cleaned.replace(/^OK: Wrote \d+ .+\n?/m, '')
  const lines = cleaned.split('\n')
  if (lines.length <= 60) return cleaned
  const head = lines.slice(0, 40).join('\n')
  const tail = lines.slice(-15).join('\n')
  return `${head}\n\n  … ${lines.length - 55} lines hidden …\n\n${tail}`
}
