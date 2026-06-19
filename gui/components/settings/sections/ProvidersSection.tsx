import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api.js'
import { useSessionStore } from '@/state/sessionStore.js'
import type { ProviderSettingsItem, SettingsSnapshot } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { providerBrandLabel, stripProviderPrefix, compactModelLabel } from '@/lib/modelDisplay.js'
import { EmptyHint, PageHeader, SettingsGroup, SettingsRow } from '@/components/settings/primitives.js'

const THINKING_LEVELS = [
  { value: '', label: 'Model default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra-high' },
  { value: 'max', label: 'Max' },
] as const

const PERMISSION_MODES = [
  { value: '', label: 'Default' },
  { value: 'read_only', label: 'Read only' },
  { value: 'reversible', label: 'Reversible' },
  { value: 'yolo', label: 'YOLO' },
] as const

export function ProvidersSection(): JSX.Element {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const globalModels = useSessionStore((s) => s.globalModels)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSettings(await api.settings.get())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const providers = settings?.providers ?? []

  const updateDefault = async (
    patch: { defaultModel?: string | null; thinkingLevel?: string | null; permissionMode?: string | null },
  ): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const next = await api.settings.updateDefaults(patch)
      setSettings(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle="Where SwarmFlow reads model credentials. Edit settings.json to add or remove providers — SwarmFlow reloads automatically."
        action={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void load()}
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
              title="Reload providers"
              aria-label="Reload providers"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => void api.settings.openFile()}
              disabled={!settings?.settingsPath}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-soft bg-pane px-3 text-[12.5px] font-medium text-ink-2 transition hover:border-line hover:bg-line-soft hover:text-ink disabled:opacity-45"
            >
              <ExternalLink className="h-3 w-3" strokeWidth={2} />
              Open settings.json
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[13px] text-error">
          {error}
        </div>
      )}

      <SettingsGroup label="Defaults">
        <SettingsRow
          title="Default model"
          subtitle="Used when a session opens without explicit selection."
          control={
            <DefaultModelPicker
              models={globalModels}
              value={settings?.defaultModel ?? ''}
              saving={saving}
              onPick={(value) => void updateDefault({ defaultModel: value || null })}
            />
          }
        />
        <SettingsRow
          title="Thinking level"
          subtitle="Applied to thinking-capable models."
          control={
            <NativeSelect
              value={settings?.thinkingLevel ?? ''}
              options={THINKING_LEVELS as unknown as ReadonlyArray<{ value: string; label: string }>}
              disabled={saving}
              onChange={(v) => void updateDefault({ thinkingLevel: v || null })}
            />
          }
        />
        <SettingsRow
          title="Permission mode"
          subtitle="Controls whether tools ask before destructive actions."
          isLast
          control={
            <NativeSelect
              value={settings?.permissionMode ?? ''}
              options={PERMISSION_MODES as unknown as ReadonlyArray<{ value: string; label: string }>}
              disabled={saving}
              onChange={(v) => void updateDefault({ permissionMode: v || null })}
            />
          }
        />
      </SettingsGroup>

      {providers.length === 0 ? (
        <SettingsGroup label="Configured providers">
          <EmptyHint text="No providers configured in settings.json." />
        </SettingsGroup>
      ) : (
        <SettingsGroup label={`Configured providers (${providers.length})`}>
          {providers.map((p, i) => (
            <ProviderRow key={p.id} provider={p} isLast={i === providers.length - 1} />
          ))}
        </SettingsGroup>
      )}

      <div className="mono mt-4 truncate px-1 text-[11.5px] text-ink-4">
        {settings?.settingsPath ?? 'settings.json'}
      </div>
    </div>
  )
}

function NativeSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  disabled?: boolean
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-[140px] cursor-pointer appearance-none rounded-lg border border-line-soft bg-pane pl-3 pr-8 text-[13px] text-ink outline-none transition hover:border-line disabled:cursor-default disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-4"
        strokeWidth={2}
      />
    </div>
  )
}

function DefaultModelPicker({
  value,
  models,
  saving,
  onPick,
}: {
  value: string
  models: readonly { name: string; provider: string; model: string }[]
  saving: boolean
  onPick: (next: string) => void
}): JSX.Element {
  const options = [{ value: '', label: 'Not set' }, ...models.map((m) => {
    const raw = compactModelLabel(m.name, m.model) || m.name
    const clean = stripProviderPrefix(raw, m.provider)
    return { value: m.name, label: `${providerBrandLabel(m.provider)} · ${clean}` }
  })]
  return (
    <NativeSelect
      value={value}
      options={options}
      disabled={saving}
      onChange={onPick}
    />
  )
}

function ProviderRow({ provider, isLast }: { provider: ProviderSettingsItem; isLast?: boolean }): JSX.Element {
  const status = providerStatus(provider)
  return (
    <div className={cn('px-4 py-3', !isLast && 'border-b border-line-soft')}>
      <div className="flex items-center gap-2.5">
        <div className="mono min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{provider.id}</div>
        <span className={cn('rounded-md px-2 py-0.5 text-[11.5px] font-medium', status.className)}>
          {status.label}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span>{provider.kind}</span>
        {provider.apiKeyEnv && <span className="mono">{provider.apiKeyEnv}</span>}
        {provider.baseUrl && <span className="mono max-w-[260px] truncate">{provider.baseUrl}</span>}
        {provider.model && <span className="mono">{provider.model}</span>}
        {provider.contextLength && <span className="mono">{formatContext(provider.contextLength)}</span>}
        {provider.hasInlineKey && <span>inline key set</span>}
      </div>
    </div>
  )
}

function providerStatus(p: ProviderSettingsItem): { label: string; className: string } {
  if (p.kind === 'invalid') return { label: 'invalid', className: 'bg-error/10 text-error' }
  if (p.kind === 'local') return { label: 'local', className: 'bg-line-soft text-ink-3' }
  if (p.hasEnvValue) return { label: 'key found', className: 'bg-success/10 text-success' }
  return { label: 'env missing', className: 'bg-warning/10 text-warning' }
}

function formatContext(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
