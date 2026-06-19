/**
 * StatusBar — transcript 和 composer 之间的薄型工作状态指示器。
 * 模板风格：仅在活跃工作时显示（虚线边框 + 标签）。
 */
import type { TabState } from '@/state/sessionStore.js'

export function StatusBar({ state }: { state: TabState | null }): JSX.Element {
  const status = state?.status
  if (!status?.currentTurnRunning) return <></>

  const label = status.lastToolCallSummary || capitalize(status.sessionPhase) || 'Working'

  return (
    <div
      data-status-bar-root
      role="status"
      aria-live="polite"
      aria-label={`Working: ${label}`}
      className="session-bottom-gutter border-y border-line-soft bg-pane py-2 pl-6"
    >
      <div className="mx-auto flex max-w-[840px] items-center gap-2.5">
        <span aria-hidden className="working-spinner" />
        <span className="truncate text-[14.5px] text-ink-2" title={label}>{label}…</span>
        <span className="ml-auto mr-3 hidden text-[11.5px] text-ink-4 sm:inline">
          Esc to interrupt
        </span>
      </div>
    </div>
  )
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
