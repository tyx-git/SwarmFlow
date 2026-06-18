import { useEffect, useState } from 'react'
import { Anchor, ChevronDown, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { EmptyHint, PageHeader, SettingsGroup } from '@/components/settings/primitives.js'

const EVENT_LABELS: Record<string, { label: string; hint: string }> = {
  SessionStart: { label: 'SessionStart', hint: 'Runs when a session boots — fail-closed' },
  UserPromptSubmit: { label: 'UserPromptSubmit', hint: 'Before the user prompt enters the turn — can rewrite or deny' },
  PreToolUse: { label: 'PreToolUse', hint: 'Before each tool execution — can deny or modify args' },
  PostToolUse: { label: 'PostToolUse', hint: 'After tool execution — context-only' },
  Notification: { label: 'Notification', hint: 'Side-channel notifications — context-only' },
}

const EVENT_ORDER = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification']

interface HooksStatusPayload {
  readonly available: boolean
  readonly hooks: readonly {
    readonly name: string
    readonly scope: string
    readonly event: string
    readonly matcher: string | null
    readonly command: string
    readonly failClosed: boolean
  }[]
}

export function HooksSection({ tab }: { tab: SessionTab | null }): JSX.Element {
  const [status, setStatus] = useState<HooksStatusPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    if (!tab || tab.status === 'draft') return
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.rpc.request<HooksStatusPayload>(tab.tabId, 'session.getHooksStatus'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [tab?.tabId, tab?.status])

  return (
    <div>
      <PageHeader
        title="Hooks"
        subtitle="Custom shell scripts that run at specific points (UserPromptSubmit, PreToolUse, etc.). Configure under hooks in settings.json."
        action={
          <button
            type="button"
            onClick={() => void load()}
            disabled={!tab || tab.status === 'draft' || loading}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
            title="Reload hooks"
            aria-label="Reload hooks"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.8} />
          </button>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[13px] text-error">
          {error}
        </div>
      )}

      {!tab || tab.status === 'draft' ? (
        <SettingsGroup>
          <EmptyHint text="Start a session to see registered hooks." />
        </SettingsGroup>
      ) : !status?.available ? (
        <SettingsGroup>
          <EmptyHint text="Hooks are not available in this runtime." />
        </SettingsGroup>
      ) : (
        <EventGroupedHooks hooks={status.hooks} />
      )}
    </div>
  )
}

function EventGroupedHooks({
  hooks,
}: {
  hooks: readonly { name: string; scope: string; event: string; matcher: string | null; command: string; failClosed: boolean }[]
}): JSX.Element {
  const byEvent = new Map<string, typeof hooks>()
  for (const h of hooks) {
    const list = (byEvent.get(h.event) ?? []) as typeof hooks
    byEvent.set(h.event, [...list, h])
  }
  // Render in canonical order first, then any unknown events
  const events = [
    ...EVENT_ORDER.filter((e) => byEvent.has(e)),
    ...Array.from(byEvent.keys()).filter((e) => !EVENT_ORDER.includes(e)),
  ]

  return (
    <div className="space-y-4">
      {events.map((event) => {
        const list = byEvent.get(event) ?? []
        const meta = EVENT_LABELS[event] ?? { label: event, hint: '' }
        return (
          <HookEventCard
            key={event}
            label={meta.label}
            hint={meta.hint}
            hooks={list}
          />
        )
      })}
      {events.length === 0 && (
        <SettingsGroup>
          <EmptyHint text="No hooks registered." />
        </SettingsGroup>
      )}
    </div>
  )
}

function HookEventCard({
  label,
  hint,
  hooks,
}: {
  label: string
  hint: string
  hooks: readonly { name: string; scope: string; event: string; matcher: string | null; command: string; failClosed: boolean }[]
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <section className="overflow-hidden rounded-xl border border-line-soft bg-pane">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-line-soft/60"
        aria-expanded={open}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <Anchor className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-ink">{label}</span>
            <span className="mono text-[11.5px] text-ink-4">
              {hooks.length} hook{hooks.length === 1 ? '' : 's'}
            </span>
          </div>
          {hint && <div className="mt-0.5 text-[12.5px] text-ink-3">{hint}</div>}
        </div>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform', !open && '-rotate-90')}
          strokeWidth={1.8}
        />
      </button>
      {open && (
        <div className="border-t border-line-soft">
          {hooks.map((hook, idx) => (
            <div
              key={`${hook.scope}:${hook.event}:${hook.name}:${idx}`}
              className={cn(
                'flex items-start gap-3 px-4 py-3',
                idx !== hooks.length - 1 && 'border-b border-line-soft',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
                  <span className="font-medium text-ink">{hook.name}</span>
                  <span className="mono rounded bg-line-soft px-1.5 py-0.5 text-[11px] text-ink-3">
                    {hook.scope}
                  </span>
                  {hook.matcher && (
                    <span className="mono text-[12px] text-ink-4">matcher: {hook.matcher}</span>
                  )}
                  {hook.failClosed && (
                    <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                      fail-closed
                    </span>
                  )}
                </div>
                <div className="mono mt-1 truncate text-[12px] text-ink-4">
                  {hook.command}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
