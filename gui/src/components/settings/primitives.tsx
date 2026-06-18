/**
 * Settings UI primitives — modeled after Cursor/Codex/OpenCode:
 * iOS-style switch, row with title+subtitle left and control right,
 * rounded-container group with thin dividers between rows, section header.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/cn.js'

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[36px] shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane-2',
        checked ? 'bg-success' : 'bg-line',
        disabled && 'cursor-default opacity-50',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

export function SettingsGroup({
  label,
  children,
  className,
}: {
  label?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={cn('mb-7', className)}>
      {label && (
        <div className="mb-2 px-1 text-[12.5px] font-medium text-ink-3">
          {label}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line-soft bg-pane">
        {children}
      </div>
    </section>
  )
}

export function SettingsRow({
  title,
  subtitle,
  control,
  onClick,
  isLast,
}: {
  title: ReactNode
  subtitle?: ReactNode
  control?: ReactNode
  onClick?: () => void
  isLast?: boolean
}): JSX.Element {
  const interactive = Boolean(onClick)
  const Tag: 'button' | 'div' = interactive ? 'button' : 'div'
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-4 px-4 py-3 text-left',
        !isLast && 'border-b border-line-soft',
        interactive && 'transition hover:bg-line-soft/60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium leading-[1.35] text-ink">{title}</div>
        {subtitle && (
          <div className="mt-0.5 text-[12.5px] leading-[1.4] text-ink-3">{subtitle}</div>
        )}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </Tag>
  )
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-[13.5px] leading-[1.45] text-ink-3">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function EmptyHint({ text }: { text: string }): JSX.Element {
  return (
    <div className="px-4 py-6 text-center text-[13.5px] text-ink-3">{text}</div>
  )
}
