/**
 * Empty state: minimal hint + CTA, no decoration.
 */
import { useState } from 'react'
import { useSessionStore } from '@/state/sessionStore.js'
import { api } from '@/lib/api.js'
import { cn } from '@/lib/cn.js'

export function EmptyState(): JSX.Element {
  const createDraftTab = useSessionStore((s) => s.createDraftTab)
  const [creating, setCreating] = useState(false)

  const start = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const dir = await api.workspace.pickDirectory()
      if (dir) createDraftTab(dir)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-pane px-8">
      <div className="flex flex-col items-center">
        <p className="text-[14.5px] text-ink-3">
          Open a workspace to start a session.
        </p>
        <button
          type="button"
          onClick={start}
          disabled={creating}
          className={cn(
            'mt-4 rounded-lg border border-line bg-pane-2 px-5 py-2.5 text-[14px] font-medium text-ink transition',
            'hover:border-ink-4/60 hover:bg-line-soft',
            creating && 'opacity-50',
          )}
        >
          {creating ? 'Opening…' : 'Open workspace…'}
        </button>
      </div>
    </div>
  )
}
