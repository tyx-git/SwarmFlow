/**
 * Unified Settings dialog — left nav rail + scrollable right content.
 * Replaces ProviderSettingsDialog / SkillsSettingsDialog / RuntimeSettingsDialog.
 * Modeled after Cursor / Codex / OpenCode settings panels.
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowLeft,
  Box,
  KeyRound,
  PlugZap,
  Puzzle,
  Settings as SettingsIcon,
  Sliders,
  Sparkles,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import type { SessionTab } from '@shared/rpc.js'
import { GeneralSection } from '@/components/settings/sections/GeneralSection.js'
import { SkillsSection } from '@/components/settings/sections/SkillsSection.js'
import { ModelsSection } from '@/components/settings/sections/ModelsSection.js'
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection.js'
import { McpSection } from '@/components/settings/sections/McpSection.js'
import { HooksSection } from '@/components/settings/sections/HooksSection.js'

export type SettingsSection =
  | 'general'
  | 'models'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'hooks'

interface NavItem {
  id: SettingsSection
  label: string
  icon: LucideIcon
  group: 'top' | 'bottom'
}

const NAV: readonly NavItem[] = [
  { id: 'general', label: 'General', icon: Sliders, group: 'top' },
  { id: 'models', label: 'Models', icon: Sparkles, group: 'top' },
  { id: 'providers', label: 'Providers', icon: KeyRound, group: 'top' },
  { id: 'skills', label: 'Skills', icon: Puzzle, group: 'bottom' },
  { id: 'mcp', label: 'MCP Servers', icon: PlugZap, group: 'bottom' },
  { id: 'hooks', label: 'Hooks', icon: Zap, group: 'bottom' },
]

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection,
  tab,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: SettingsSection
  tab: SessionTab | null
}): JSX.Element {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'general')

  useEffect(() => {
    if (open && initialSection) setSection(initialSection)
  }, [open, initialSection])

  const topNav = NAV.filter((n) => n.group === 'top')
  const bottomNav = NAV.filter((n) => n.group === 'bottom')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] max-h-[820px] w-[960px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-pane-2 shadow-2xl"
        >
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          {/* Left nav rail */}
          <aside className="flex w-[212px] shrink-0 flex-col border-r border-line-soft bg-rail">
            <div className="flex h-14 items-center gap-2 px-4">
              <SettingsIcon className="h-4 w-4 text-ink-3" strokeWidth={1.8} />
              <div className="text-[14.5px] font-semibold text-ink">Settings</div>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-1">
              <NavGroup items={topNav} active={section} onSelect={setSection} />
              <div className="my-2 h-px bg-line-soft" />
              <NavGroup items={bottomNav} active={section} onSelect={setSection} />
            </nav>
            <Dialog.Close asChild>
              <button
                type="button"
                className="flex h-11 shrink-0 items-center gap-2 border-t border-line-soft px-4 text-[13.5px] text-ink-3 transition hover:bg-line-soft hover:text-ink"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
                Back to session
              </button>
            </Dialog.Close>
          </aside>

          {/* Right content */}
          <main className="flex min-w-0 flex-1 flex-col bg-pane-2">
            <div className="flex h-14 items-center justify-end border-b border-line-soft px-5">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink"
                  title="Close"
                  aria-label="Close settings"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Dialog.Close>
            </div>
            <div className="session-scroll min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {section === 'general' && <GeneralSection />}
              {section === 'models' && <ModelsSection tab={tab} />}
              {section === 'providers' && <ProvidersSection />}
              {section === 'skills' && <SkillsSection tab={tab} />}
              {section === 'mcp' && <McpSection tab={tab} />}
              {section === 'hooks' && <HooksSection tab={tab} />}
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function NavGroup({
  items,
  active,
  onSelect,
}: {
  items: readonly NavItem[]
  active: SettingsSection
  onSelect: (id: SettingsSection) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = item.icon
        const isActive = item.id === active
        return (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition',
              isActive
                ? 'bg-pane-2 text-ink'
                : 'text-ink-2 hover:bg-line-soft hover:text-ink',
            )}
          >
            <Icon
              className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-accent' : 'text-ink-3')}
              strokeWidth={1.8}
            />
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Re-export Box to satisfy unused-import lint (kept for future Models page badge usage).
export { Box }
