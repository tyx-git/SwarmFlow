import { Monitor, Moon, Sun } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import { PageHeader, SettingsGroup, SettingsRow, Switch } from '@/components/settings/primitives.js'
import { cn } from '@/lib/cn.js'

export function GeneralSection(): JSX.Element {
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  const useSystemTheme = useSessionStore((s) => s.useSystemTheme)
  const autoUpdate = useSessionStore((s) => s.autoUpdate)
  const setAutoUpdate = useSessionStore((s) => s.setAutoUpdate)
  const markdownMode = useSessionStore((s) => s.markdownMode)
  const setMarkdownMode = useSessionStore((s) => s.setMarkdownMode)

  const followingSystem = !localStorage.getItem('swarmflow:theme')

  return (
    <div>
      <PageHeader
        title="General"
        subtitle="App-wide preferences applied across all sessions."
      />

      <SettingsGroup label="Appearance">
        <SettingsRow
          title="Theme"
          subtitle="Switch between light, dark, or system."
          control={
            <ThemePicker
              theme={theme}
              followingSystem={followingSystem}
              onPick={(t) => {
                if (t === 'system') void useSystemTheme()
                else setTheme(t)
              }}
            />
          }
        />
        <SettingsRow
          title="Render markdown"
          subtitle="Renders headings, lists, and code blocks. Disable to see raw text."
          isLast
          control={
            <Switch
              checked={markdownMode === 'rendered'}
              onChange={(next) => setMarkdownMode(next ? 'rendered' : 'raw')}
              label="Render markdown"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Updates">
        <SettingsRow
          title="Auto-update"
          subtitle="Periodically check npm for newer swarmflow releases."
          isLast
          control={
            <Switch
              checked={autoUpdate}
              onChange={(next) => void setAutoUpdate(next)}
              label="Auto-update"
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}

function ThemePicker({
  theme,
  followingSystem,
  onPick,
}: {
  theme: 'light' | 'dark'
  followingSystem: boolean
  onPick: (next: 'light' | 'dark' | 'system') => void
}): JSX.Element {
  const choice: 'light' | 'dark' | 'system' = followingSystem
    ? 'system'
    : theme
  const opts: Array<{ id: 'light' | 'dark' | 'system'; label: string; icon: typeof Sun }> = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ]
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line-soft bg-pane-2 p-0.5">
      {opts.map((opt) => {
        const Icon = opt.icon
        const active = choice === opt.id
        return (
          <button
            type="button"
            key={opt.id}
            onClick={() => onPick(opt.id)}
            title={opt.label}
            aria-label={opt.label}
            aria-pressed={active}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition',
              active
                ? 'bg-line text-ink shadow-[inset_0_0_0_1px_var(--color-line)]'
                : 'text-ink-3 hover:text-ink',
            )}
          >
            <Icon className="h-3 w-3" strokeWidth={2} />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}
