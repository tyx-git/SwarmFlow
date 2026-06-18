import { useEffect, useState } from 'react'
import { Brain, Check, Image as ImageIcon, RefreshCw, Search, X } from 'lucide-react'
import { api } from '@/lib/api.js'
import type { ModelDescriptor, SessionTab } from '@shared/rpc.js'
import { useSessionStore } from '@/state/sessionStore.js'
import { cn } from '@/lib/cn.js'
import { providerBrandLabel, compactModelLabel, stripProviderPrefix } from '@/lib/modelDisplay.js'
import { EmptyHint, PageHeader, SettingsGroup, SettingsRow } from '@/components/settings/primitives.js'

export function ModelsSection({ tab }: { tab: SessionTab | null }): JSX.Element {
  const globalModels = useSessionStore((s) => s.globalModels)
  const perTabModels = useSessionStore((s) => (tab ? s.perTab[tab.tabId]?.models : undefined))
  const meta = useSessionStore((s) => (tab ? s.perTab[tab.tabId]?.meta : undefined))
  const selectModel = useSessionStore((s) => s.selectModel)
  const [refreshTick, setRefreshTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  const refresh = async (): Promise<void> => {
    if (!tab || tab.status === 'draft') return
    setLoading(true)
    setError(null)
    try {
      const models = await api.rpc.request<readonly ModelDescriptor[]>(tab.tabId, 'session.listAvailableModels')
      useSessionStore.setState((s) => {
        const next = { ...s.perTab }
        const prev = next[tab.tabId]
        if (prev) next[tab.tabId] = { ...prev, models }
        return { perTab: next, globalModels: models.length > 0 ? models : s.globalModels }
      })
      setRefreshTick((t) => t + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.tabId])

  const allModels: readonly ModelDescriptor[] =
    perTabModels && perTabModels.length > 0 ? perTabModels : globalModels
  const current = meta?.modelConfigName ?? tab?.selectedModel ?? ''

  const q = query.trim().toLowerCase()
  const visible = q
    ? allModels.filter((m) =>
        `${m.name} ${m.provider} ${m.model} ${providerBrandLabel(m.provider)}`.toLowerCase().includes(q),
      )
    : allModels

  // group by provider
  const order: string[] = []
  const groups = new Map<string, ModelDescriptor[]>()
  for (const m of visible) {
    if (!groups.has(m.provider)) {
      order.push(m.provider)
      groups.set(m.provider, [])
    }
    groups.get(m.provider)!.push(m)
  }

  return (
    <div>
      <PageHeader
        title="Models"
        subtitle="Pick the model that runs in the active session. Switch any time — context carries over."
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={!tab || tab.status === 'draft' || loading}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
            title="Reload models"
            aria-label="Reload models"
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

      {allModels.length > 0 && (
        <div className="mb-4 flex h-9 items-center gap-2 rounded-lg border border-line-soft bg-pane px-3 transition focus-within:border-line">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-4"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="grid h-6 w-6 place-items-center rounded text-ink-4 transition hover:bg-line-soft hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {allModels.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text="Start a session to load available models from your providers." />
        </SettingsGroup>
      ) : visible.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text={`No models match “${query}”.`} />
        </SettingsGroup>
      ) : (
        order.map((provider) => {
          const items = groups.get(provider) ?? []
          const hasActive = items.some((m) => m.name === current)
          return (
            <SettingsGroup
              key={provider}
              label={
                <span className={cn('flex items-center gap-2', hasActive && 'text-accent')}>
                  <span>{providerBrandLabel(provider).toUpperCase()}</span>
                  <span className="mono text-[11px] font-normal text-ink-4">
                    {items.length} model{items.length === 1 ? '' : 's'}
                  </span>
                </span>
              }
            >
              {items.map((m, idx) => (
                <ModelRow
                  key={m.name}
                  model={m}
                  active={m.name === current}
                  isLast={idx === items.length - 1}
                  onSelect={() => {
                    if (!tab || tab.status === 'draft') return
                    void selectModel(tab.tabId, m.name)
                  }}
                  refreshTick={refreshTick}
                />
              ))}
            </SettingsGroup>
          )
        })
      )}
    </div>
  )
}

function ModelRow({
  model,
  active,
  isLast,
  onSelect,
  refreshTick: _refreshTick,
}: {
  model: ModelDescriptor
  active: boolean
  isLast: boolean
  onSelect: () => void
  refreshTick: number
}): JSX.Element {
  const rawName = compactModelLabel(model.name, model.model) || model.name
  const displayName = stripProviderPrefix(rawName, model.provider)
  const details = [
    model.model && model.model !== displayName && model.model !== rawName ? model.model : null,
    fmtContext(model.contextLength),
  ].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3 text-left transition',
        !isLast && 'border-b border-line-soft',
        'hover:bg-line-soft/60',
        active && 'bg-line-soft/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
          <span className="truncate">{displayName}</span>
          {active && (
            <span className="mono shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
              Active
            </span>
          )}
        </div>
        {details && (
          <div className="mono mt-0.5 truncate text-[12px] text-ink-3">{details}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-ink-3">
        {model.supportsThinking && (
          <span title="Supports thinking">
            <Brain className="h-3.5 w-3.5" strokeWidth={1.7} />
          </span>
        )}
        {model.supportsMultimodal && (
          <span title="Supports images">
            <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.7} />
          </span>
        )}
        {active && <Check className="h-4 w-4 text-success" strokeWidth={2.2} />}
      </div>
    </button>
  )
}

function fmtContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ctx`
  return `${n} ctx`
}
