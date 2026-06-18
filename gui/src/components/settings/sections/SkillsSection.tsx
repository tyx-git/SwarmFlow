import { useEffect, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { EmptyHint, PageHeader, SettingsGroup, SettingsRow, Switch } from '@/components/settings/primitives.js'

interface SkillItem {
  readonly name: string
  readonly description: string
  readonly enabled: boolean
}

export function SkillsSection({ tab }: { tab: SessionTab | null }): JSX.Element {
  const [skills, setSkills] = useState<readonly SkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = async (): Promise<void> => {
    if (!tab || tab.status === 'draft') {
      setSkills([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.rpc.request<readonly SkillItem[]>(tab.tabId, 'session.listSkills')
      setSkills([...result].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [tab?.tabId, tab?.status])

  const onToggle = async (skill: SkillItem, next: boolean): Promise<void> => {
    if (!tab || saving) return
    setSaving(skill.name)
    setError(null)
    setSkills((items) => items.map((it) => (it.name === skill.name ? { ...it, enabled: next } : it)))
    try {
      await api.rpc.request(tab.tabId, 'session.setSkillEnabled', { name: skill.name, enabled: next })
    } catch (err) {
      setSkills((items) => items.map((it) => (it.name === skill.name ? skill : it)))
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Skills"
        subtitle="Domain-specific capabilities the agent can invoke. Toggle to make them available in the current session."
        action={
          <button
            type="button"
            onClick={() => void load()}
            disabled={!tab || loading}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
            title="Reload skills"
            aria-label="Reload skills"
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
          <EmptyHint text="Start a session to toggle skills." />
        </SettingsGroup>
      ) : loading && skills.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text="Loading skills…" />
        </SettingsGroup>
      ) : skills.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text="No skills installed." />
        </SettingsGroup>
      ) : (
        <SkillsList
          skills={skills}
          query={query}
          setQuery={setQuery}
          onToggle={onToggle}
          saving={saving}
        />
      )}
    </div>
  )
}

function SkillsList({
  skills,
  query,
  setQuery,
  onToggle,
  saving,
}: {
  skills: readonly SkillItem[]
  query: string
  setQuery: (next: string) => void
  onToggle: (skill: SkillItem, next: boolean) => Promise<void>
  saving: string | null
}): JSX.Element {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))
    : skills

  return (
    <>
      <div className="mb-4 flex h-9 items-center gap-2 rounded-lg border border-line-soft bg-pane px-3 transition focus-within:border-line">
        <Search className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={2} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills"
          aria-label="Search skills"
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

      {filtered.length === 0 ? (
        <SettingsGroup>
          <EmptyHint text={`No skills match “${query}”.`} />
        </SettingsGroup>
      ) : (
        <SettingsGroup
          label={
            filtered.length === skills.length
              ? `${skills.length} skill${skills.length === 1 ? '' : 's'}`
              : `${filtered.length} of ${skills.length}`
          }
        >
          {filtered.map((skill, idx) => (
            <SettingsRow
              key={skill.name}
              title={skill.name}
              subtitle={skill.description || 'No description'}
              isLast={idx === filtered.length - 1}
              control={
                <Switch
                  checked={skill.enabled}
                  onChange={(next) => void onToggle(skill, next)}
                  disabled={saving !== null}
                  label={`Toggle ${skill.name}`}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}
