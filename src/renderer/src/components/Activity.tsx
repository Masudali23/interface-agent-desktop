import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Block, Message } from '@shared/types'
import { activitySummary, elapsedText, estimateTokens, runtimeActivity, tokens, toolProgress, toolSummary } from '../lib/format'
import type { LiveStep, ToolBlock } from '../lib/timeline'
import { useApp } from '../store'
import { Icon, type IconName } from './Icon'
import { ToolCard, toolIcon } from './ToolCard'

/** The current time, refreshed every second while `active`. Only the small live parts
 *  of a turn use it, so the rest of the transcript does not re-render each second. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function LiveDots({ color }: { color?: string }) {
  return (
    <span className="tx-dots" style={color ? ({ '--dots-color': color } as CSSProperties) : undefined} aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

function Elapsed({ since }: { since?: number }) {
  const now = useNow(since !== undefined)
  return since === undefined ? null : <span className="tx-act-time">{elapsedText(now - since)}</span>
}

function ThinkingStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tx-step ${open ? 'open' : ''}`}>
      <button className="tx-step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="brain" size={13} className="tx-step-icon" />
        <span className="tx-step-verb">Thought</span>
        <span className="tx-step-summary tx-step-prose">{text.split('\n')[0]}</span>
        <span className="tx-step-state" />
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="tx-step-chevron" />
      </button>
      {open && <div className="tx-thinking">{text}</div>}
    </div>
  )
}

function groupIcon(blocks: Block[]): IconName {
  const icons = new Set(blocks.filter((b): b is ToolBlock => b.kind === 'tool').map((b) => toolIcon(b.name)))
  if (icons.size === 0) return 'brain'
  return icons.size === 1 ? [...icons][0] : 'layers'
}

interface ActivityProps {
  blocks: Block[]
  /** What this row is doing now, while the turn runs (see `liveStep`). */
  step?: LiveStep
  root: string
  memberId: string
  messageId: string
  color?: string
}

/** A run of thinking and tool steps folded into one line, like Claude desktop. */
export const ActivityGroup = memo(function ActivityGroup({ blocks, step, root, memberId, messageId, color }: ActivityProps) {
  const [open, setOpen] = useState(false)
  const { text, failed } = useMemo(() => activitySummary(blocks), [blocks])
  const tools = blocks.filter((b): b is ToolBlock => b.kind === 'tool')
  const thoughts = blocks.filter((b) => b.kind === 'thinking' && b.text.trim())
  const running = step?.kind === 'tool' ? step.block : undefined
  const thinkingNow = step?.kind === 'thinking' ? step.block : undefined
  const single = tools.length === 1 && blocks.length === 1 ? tools[0] : undefined
  const onlyThinking = tools.length === 0
  const expandable = tools.length > 0 || thoughts.length > 0

  const label = running ? toolProgress(running.name) : thinkingNow ? 'Thinking' : text
  const since = running ? running.at : thinkingNow?.at
  const detail = running ? toolSummary(running.name, running.input, root) : single ? toolSummary(single.name, single.input, root) : ''

  return (
    <div className={`tx-act ${open ? 'open' : ''} ${running || thinkingNow ? 'live' : ''}`}>
      <button className="tx-act-head" onClick={() => expandable && setOpen(!open)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
        {running || thinkingNow ? <LiveDots color={color} /> : <Icon name={groupIcon(blocks)} size={14} className="tx-act-icon" />}
        <span className="tx-act-label">{label}</span>
        {(running || thinkingNow) && <Elapsed since={since} />}
        {detail && <span className="tx-act-detail">{detail}</span>}
        {failed > 0 && !running && <span className="tx-act-failed">· {failed} failed</span>}
        {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="tx-act-chevron" />}
      </button>
      {open && (onlyThinking ? (
        <div className="tx-thinking">{thoughts.map((b) => b.kind === 'thinking' ? b.text : '').join('\n\n')}</div>
      ) : (
        <div className="tx-act-steps">
          {blocks.map((b) => b.kind === 'tool'
            ? <ToolCard key={b.id} block={b} root={root} memberId={memberId} messageId={messageId} />
            : b.kind === 'thinking' && b.text.trim() ? <ThinkingStep key={b.id} text={b.text} /> : null)}
        </div>
      ))}
    </div>
  )
})

interface StatusProps {
  message: Message
  roomId: string
  color?: string
}

/** "•• 1m 4s · 1.2k tokens · Thinking" under the newest part of a running turn. */
export function LiveStatus({ message, roomId, color }: StatusProps) {
  const runtime = useApp((s) => s.statuses[roomId]?.[message.author])
  const now = useNow(true)
  const estimate = useMemo(() => estimateTokens(message), [message])
  const written = Math.max(runtime?.turnOutputTokens ?? 0, estimate)
  const parts = [elapsedText(now - message.createdAt), written ? `${tokens(written)} tokens` : '', runtimeActivity(runtime)].filter(Boolean)
  return (
    <div className="tx-status">
      <LiveDots color={color} />
      {parts.map((part, i) => (
        <span key={i} className="tx-status-part">{part}</span>
      ))}
    </div>
  )
}
