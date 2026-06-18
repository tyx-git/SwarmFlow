import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, X } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { api } from '@/lib/api.js'
import type { McpServerInput, SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { EmptyHint, PageHeader, SettingsGroup } from '@/components/settings/primitives.js'

interface McpStatusPayload {
  readonly configured: boolean
  readonly error: string | null
  readonly toolCount: number
  readonly servers: readonly {
    readonly name: string
    readonly state: string | null
    readonly error: string | null
    readonly tools: readonly string[]
  }[]
}

export function McpSection({ tab }: { tab: SessionTab | null }): JSX.Element {
  const [status, setStatus] = useState<McpStatusPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<{
    name: string
    command: string
    args: readonly string[]
    env: Record<string, string>
    url: string
  } | null>(null)

  const load = async (): Promise<void> => {
    if (!tab || tab.status === 'draft') return
    setLoading(true)
    setError(null)
    try {
      const result = await api.rpc.request<McpStatusPayload>(tab.tabId, 'session.getMcpStatus')
      setStatus(result)
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
        title="MCP Servers"
        subtitle="External tool servers SwarmFlow can connect to. Configure under mcpServers in settings.json."
        action={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void load()}
              disabled={!tab || tab.status === 'draft' || loading}
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
              title="Reload MCP status"
              aria-label="Reload MCP status"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing({ name: '', command: '', args: [], env: {}, url: '' })
                setFormOpen(true)
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-pane transition hover:opacity-90"
            >
              <Plus className="h-3 w-3" strokeWidth={2.2} />
              Add server
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[13px] text-error">
          {error}
        </div>
      )}

      {!tab || tab.status === 'draft' ? (
        <SettingsGroup>
          <EmptyHint text="Start a session to see MCP server status." />
        </SettingsGroup>
      ) : !status?.configured ? (
        <SettingsGroup>
          <EmptyHint text="No MCP servers configured. Click ‘Add server’ to create one." />
        </SettingsGroup>
      ) : status.servers.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text="MCP runtime reported no servers." />
        </SettingsGroup>
      ) : (
        <SettingsGroup
          label={
            <span>
              {status.servers.length} server{status.servers.length === 1 ? '' : 's'} ·{' '}
              <span className="mono">{status.toolCount}</span> tool{status.toolCount === 1 ? '' : 's'}
            </span>
          }
        >
          {status.servers.map((s, idx) => (
            <McpRow
              key={s.name}
              server={s}
              isLast={idx === status.servers.length - 1}
              onEdit={() => {
                setEditing({
                  name: s.name,
                  command: '',
                  args: [],
                  env: {},
                  url: '',
                })
                setFormOpen(true)
              }}
              onDelete={async () => {
                if (!confirm(`Remove MCP server “${s.name}”? This rewrites settings.json.`)) return
                try {
                  await api.settings.deleteMcpServer(s.name)
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err))
                }
              }}
            />
          ))}
        </SettingsGroup>
      )}

      <McpServerForm
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditing(null)
        }}
        initial={editing}
        onSubmit={async (input) => {
          await api.settings.upsertMcpServer(input)
          await load()
        }}
      />
    </div>
  )
}

function McpRow({
  server,
  isLast,
  onEdit,
  onDelete,
}: {
  server: { name: string; state: string | null; error: string | null; tools: readonly string[] }
  isLast: boolean
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className={cn('group flex items-start gap-4 px-4 py-3', !isLast && 'border-b border-line-soft')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px]">
          <span className="font-medium text-ink">{server.name}</span>
          <StateBadge state={server.state} error={server.error} />
        </div>
        {server.error ? (
          <div className="mt-1 text-[12.5px] text-error">{server.error}</div>
        ) : server.tools.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {server.tools.slice(0, 16).map((t) => (
              <span key={t} className="mono rounded bg-line-soft px-1.5 py-0.5 text-[11px] text-ink-3">
                {t}
              </span>
            ))}
            {server.tools.length > 16 && (
              <span className="mono rounded bg-line-soft px-1.5 py-0.5 text-[11px] text-ink-4">
                +{server.tools.length - 16}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-ink-4">No tools registered</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove server"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-3 transition hover:bg-line-soft hover:text-error"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}

function McpServerForm({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: { name: string; command: string; args: readonly string[]; env: Record<string, string>; url: string } | null
  onSubmit: (input: McpServerInput) => Promise<void>
}): JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([])
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previousName = initial?.name ?? ''

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setCommand(initial?.command ?? '')
    setArgsText((initial?.args ?? []).join('\n'))
    setEnvPairs(
      Object.entries(initial?.env ?? {}).map(([key, value]) => ({ key, value })),
    )
    setUrl(initial?.url ?? '')
    setError(null)
  }, [open, initial])

  const handleSubmit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const args = argsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      const env: Record<string, string> = {}
      for (const { key, value } of envPairs) {
        const k = key.trim()
        if (!k) continue
        env[k] = value
      }
      await onSubmit({
        name: name.trim(),
        previousName: previousName || undefined,
        command: command.trim() || undefined,
        args: args.length > 0 ? args : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        url: url.trim() || undefined,
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] flex max-h-[80vh] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-pane-2 shadow-2xl"
        >
          <div className="flex h-14 items-center gap-3 border-b border-line-soft px-5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-[15.5px] font-semibold leading-tight text-ink">
                {previousName ? 'Edit MCP server' : 'Add MCP server'}
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="session-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className="mb-3 rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[13px] text-error">
                {error}
              </div>
            )}

            <FormField label="Name" hint="Identifier used in settings.json (e.g. filesystem)">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                className="h-9 w-full rounded-lg border border-line-soft bg-pane px-3 text-[14px] text-ink outline-none focus:border-line"
              />
            </FormField>

            <FormField label="Command" hint="The executable launched in a subprocess (leave empty if using URL).">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="mono h-9 w-full rounded-lg border border-line-soft bg-pane px-3 text-[13.5px] text-ink outline-none focus:border-line"
              />
            </FormField>

            <FormField label="Arguments" hint="One per line.">
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={3}
                placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/Users/me"
                className="mono w-full resize-none rounded-lg border border-line-soft bg-pane px-3 py-2 text-[13.5px] text-ink outline-none focus:border-line"
              />
            </FormField>

            <FormField label="Environment variables">
              <div className="flex flex-col gap-1.5">
                {envPairs.map((pair, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      value={pair.key}
                      onChange={(e) =>
                        setEnvPairs((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)),
                        )
                      }
                      placeholder="KEY"
                      className="mono h-8 flex-1 rounded-lg border border-line-soft bg-pane px-2.5 text-[13px] text-ink outline-none focus:border-line"
                    />
                    <input
                      value={pair.value}
                      onChange={(e) =>
                        setEnvPairs((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)),
                        )
                      }
                      placeholder="value"
                      className="mono h-8 flex-1 rounded-lg border border-line-soft bg-pane px-2.5 text-[13px] text-ink outline-none focus:border-line"
                    />
                    <button
                      type="button"
                      onClick={() => setEnvPairs((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label="Remove env variable"
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-4 transition hover:bg-line-soft hover:text-error"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setEnvPairs((prev) => [...prev, { key: '', value: '' }])}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-soft px-3 text-[12.5px] font-medium text-ink-3 transition hover:border-line hover:text-ink"
                >
                  <Plus className="h-3 w-3" strokeWidth={2} />
                  Add variable
                </button>
              </div>
            </FormField>

            <FormField label="URL" hint="Optional. Use for SSE-transport MCP servers in place of a command.">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className="mono h-9 w-full rounded-lg border border-line-soft bg-pane px-3 text-[13.5px] text-ink outline-none focus:border-line"
              />
            </FormField>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={submitting}
                className="rounded-lg px-3 py-1.5 text-[13.5px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !name.trim() || (!command.trim() && !url.trim())}
              className="rounded-lg bg-ink px-3 py-1.5 text-[13.5px] font-medium text-pane transition hover:opacity-90 disabled:opacity-40"
            >
              {submitting ? 'Saving…' : previousName ? 'Save changes' : 'Add server'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-[13px] font-medium text-ink-2">{label}</label>
      </div>
      {children}
      {hint && <div className="mt-1 text-[12px] text-ink-4">{hint}</div>}
    </div>
  )
}

function StateBadge({ state, error }: { state: string | null; error: string | null }): JSX.Element {
  const tone = error ? 'error' : state === 'ready' || state === 'connected' ? 'success' : 'neutral'
  const label = error ? 'error' : state ?? 'unknown'
  return (
    <span
      className={cn(
        'rounded-md px-2 py-0.5 text-[11.5px] font-medium',
        tone === 'success' && 'bg-success/10 text-success',
        tone === 'error' && 'bg-error/10 text-error',
        tone === 'neutral' && 'bg-line-soft text-ink-3',
      )}
    >
      {label}
    </span>
  )
}
