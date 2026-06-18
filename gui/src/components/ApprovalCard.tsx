/**
 * Inline approval card. Renders when the active session has a pending
 * `approval` ask.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Check, X } from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'

interface ApprovalAsk {
  id: string
  kind: 'approval'
  summary: string
  payload: {
    toolCallId: string
    toolName: string
    toolSummary: string
    permissionClass: string
    offers: Array<{
      type: string
      label: string
      scope?: string
    }>
  }
  options: string[]
}

interface AgentQuestionAsk {
  id: string
  kind: 'agent_question'
  summary: string
  payload: {
    toolCallId: string
    questions: Array<{
      question: string
      options: Array<{ label: string; description?: string; kind: string }>
    }>
  }
}

type AnyAsk = ApprovalAsk | AgentQuestionAsk

export function AskBar({ tab }: { tab: SessionTab }): JSX.Element | null {
  const [ask, setAsk] = useState<AnyAsk | null>(null)

  useEffect(() => {
    if (tab.status === 'draft') {
      setAsk(null)
      return
    }
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const a = await api.rpc.request<AnyAsk | null>(tab.tabId, 'session.getPendingAsk')
        if (!cancelled) setAsk(a)
      } catch {
        if (!cancelled) setAsk(null)
      }
    }
    void refresh()
    const off = api.rpc.onEvent((e) => {
      if (e.tabId !== tab.tabId) return
      if (e.method === 'ask.pending' || e.method === 'ask.resolved' || e.method === 'log.changed') {
        void refresh()
      }
    })
    return () => { cancelled = true; off() }
  }, [tab.status, tab.tabId])

  if (!ask) return null
  if (ask.kind === 'approval') return <ApprovalCard tab={tab} ask={ask} />
  if (ask.kind === 'agent_question') return <QuestionCard tab={tab} ask={ask} />
  return null
}

function ApprovalCard({ tab, ask }: { tab: SessionTab; ask: ApprovalAsk }): JSX.Element {
  const [selected, setSelected] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const options = ask.options
  const offers = ask.payload.offers
  const denyIndex = options.findIndex((o) => /^deny/i.test(o))
  const isDangerous = ask.payload.permissionClass.includes('danger')

  useEffect(() => {
    setSelected(0)
    setSubmitting(false)
  }, [ask.id])

  const resolve = async (idx: number): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.rpc.request(tab.tabId, 'session.resolveApprovalAsk', {
        askId: ask.id,
        choiceIndex: idx,
      })
      try {
        await api.rpc.request(tab.tabId, 'session.resumePendingTurn')
      } catch { /* */ }
    } catch (err) {
      console.error('resolveApprovalAsk failed', err)
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (submitting) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => {
          const next = e.key === 'ArrowDown' ? s + 1 : s - 1
          return Math.max(0, Math.min(options.length - 1, next))
        })
      }
      if (e.key === 'Enter') { e.preventDefault(); void resolve(selected) }
      if (e.key === 'Escape') { e.preventDefault(); if (denyIndex >= 0) void resolve(denyIndex) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, submitting, options.length, denyIndex])

  return (
    <div className="px-6 pb-2 pt-1">
      <div className="mx-auto max-w-[840px]">
        <div
          className={cn(
            'rounded-xl border bg-pane-2',
            isDangerous ? 'border-error/40' : 'border-line',
          )}
        >
          <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
            <div className={cn(
              'grid h-6 w-6 shrink-0 place-items-center rounded-full',
              isDangerous ? 'bg-error/15 text-error' : 'bg-ink-4/20 text-ink-3',
            )}>
              {isDangerous ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[14.5px] font-medium text-ink">Approval needed</span>
                <span className="mono text-[12px] text-ink-3">
                  {ask.payload.permissionClass.replaceAll('_', ' ')}
                </span>
              </div>
              <div className="mt-0.5 text-[16px] text-ink-2">{ask.payload.toolSummary}</div>
            </div>
          </div>

          <ul className="px-2 pb-2">
            {options.map((label, i) => {
              const offer = offers[i]
              const isDeny = i === denyIndex
              const active = i === selected
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => void resolve(i)}
                    onMouseEnter={() => setSelected(i)}
                    disabled={submitting}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded px-3 py-2 text-left transition',
                      active ? 'bg-line-soft text-ink' : 'text-ink-2 hover:bg-line-soft/60',
                      isDeny && active && 'text-error',
                    )}
                  >
                    <span className={cn(
                      'grid h-5 w-5 shrink-0 place-items-center rounded-full border',
                      isDeny
                        ? active ? 'border-error/40 bg-error/15 text-error' : 'border-line text-ink-3'
                        : active ? 'border-success/40 bg-success/15 text-success' : 'border-line text-ink-3',
                    )}>
                      {isDeny ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                    </span>
                    <span className="flex-1 truncate text-[14.5px]">{label}</span>
                    {offer?.scope && (
                      <span className="mono text-[12px] text-ink-3">
                        {offer.scope}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="flex items-center justify-between border-t border-line-soft px-4 py-2">
            <span className="mono truncate text-[12px] text-ink-4">
              {ask.payload.toolName}
            </span>
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[12px] font-medium',
                isDangerous ? 'bg-error/10 text-error' : 'bg-success/10 text-success',
              )}
            >
              {isDangerous ? 'review' : 'ready'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function QuestionCard({ tab, ask }: { tab: SessionTab; ask: AgentQuestionAsk }): JSX.Element {
  const [answers, setAnswers] = useState<number[]>(() => ask.payload.questions.map(() => 0))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setAnswers(ask.payload.questions.map(() => 0))
    setSubmitting(false)
  }, [ask.id, ask.payload.questions])

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const decision = {
        answers: ask.payload.questions.map((q, i) => ({
          questionIndex: i,
          selectedOptionIndex: answers[i] ?? 0,
          answerText: q.options[answers[i] ?? 0]?.label ?? '',
        })),
      }
      await api.rpc.request(tab.tabId, 'session.resolveAgentQuestionAsk', { askId: ask.id, decision })
      try { await api.rpc.request(tab.tabId, 'session.resumePendingTurn') } catch { /* */ }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="px-6 pb-2 pt-1">
      <div className="mx-auto max-w-[840px]">
        <div className="rounded-xl border border-line bg-pane-2 p-4">
          <div className="text-[14.5px] font-medium text-ink">{ask.summary}</div>
          <div className="mt-3 space-y-3">
            {ask.payload.questions.map((q, qi) => (
              <div key={qi}>
                <div className="text-[14.5px] text-ink-2">{q.question}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {q.options.map((opt, oi) => (
                    <button
                      type="button"
                      key={oi}
                      onClick={() => setAnswers((a) => a.map((v, idx) => (idx === qi ? oi : v)))}
                      className={cn(
                        'rounded px-2.5 py-1 text-[14px] transition',
                        answers[qi] === oi
                          ? 'bg-ink text-pane'
                          : 'bg-line-soft text-ink-2 hover:bg-line hover:text-ink',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              className="rounded bg-ink px-3 py-1.5 text-[14px] font-medium text-pane transition hover:opacity-90 disabled:opacity-50"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
