import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ApprovalDecision, Block, Question } from '@shared/types'
import { str } from '../lib/format'
import { useApp } from '../store'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { ToolDetails } from './ToolCard'

type Approval = Extract<Block, { kind: 'approval' }>
type Input = Record<string, unknown>

const DONE_TEXT: Record<string, string> = {
  allowed: 'Allowed',
  always: 'Always allowed',
  denied: 'Denied',
  answered: 'Answered',
  expired: 'No longer waiting'
}

const CODEX_TITLE: Record<string, string> = {
  command: 'wants to run a command',
  'file change': 'wants to change files',
  permissions: 'wants extra permissions',
  question: 'has a question'
}

/** The primary action's shortcut: accepted inside the card, and from anywhere else while
 *  this is the only request waiting and you are not typing (an empty composer counts). */
function ShortcutHint() {
  const mac = useApp((s) => s.platform) === 'darwin'
  return (
    <span className="tx-kbd" aria-hidden="true">
      {mac ? <><kbd>⌘</kbd><kbd>↵</kbd></> : <><kbd>Ctrl</kbd><kbd>↵</kbd></>}
    </span>
  )
}

const isShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }): boolean =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing

function onShortcut(enabled: boolean, run: () => void) {
  return (e: KeyboardEvent): void => {
    if (!enabled || !isShortcut({ ...e, isComposing: e.nativeEvent.isComposing })) return
    e.preventDefault()
    run()
  }
}

/** Text the user is writing somewhere outside the card; the shortcut then stays theirs.
 *  A composer holding attachments (or still saving one) has a message to send even with
 *  no text, so Cmd/Ctrl+Enter there queues or sends it rather than answering the card. */
function typing(el: Element | null): boolean {
  if (el?.closest('.cmp')?.querySelector('.cmp-attachments')) return true
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== 'checkbox' && el.type !== 'radio')) return el.value.trim() !== ''
  return el instanceof HTMLElement && el.isContentEditable
}

/** Lets the shortcut answer a waiting request while focus is still in the composer. */
function useRoomShortcut(blockId: string, enabled: boolean, run: () => void) {
  const action = useRef(run)
  action.current = run
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.defaultPrevented || !isShortcut(e)) return
      const active = document.activeElement
      if (active?.closest('[data-approval]') || typing(active)) return
      // The same request can show in two places (shared chat and an agent panel).
      const waiting = new Set([...document.querySelectorAll<HTMLElement>('[data-approval][data-waiting]')].map((el) => el.dataset.approval))
      if (waiting.size !== 1 || !waiting.has(blockId)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      action.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [blockId, enabled])
}

function Questions({ block, questions, onAnswer }: { block: Approval; questions: Question[]; onAnswer: (d: ApprovalDecision) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const pending = block.status === 'pending'
  const toggle = (q: Question, label: string): void => {
    const cur = picked[q.id] ?? []
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
    setPicked({ ...picked, [q.id]: next })
  }
  const answers = Object.fromEntries(
    questions.map((q) => {
      const custom = other[q.id]?.trim()
      const chosen = picked[q.id] ?? []
      return [q.id, custom ? [...chosen, custom].join(', ') : chosen.join(', ')]
    })
  )
  const complete = questions.every((q) => answers[q.id])
  const send = (): void => {
    if (complete) onAnswer({ kind: 'answer', answers })
  }
  useRoomShortcut(block.id, pending, send)
  return (
    <div className="tx-questions" onKeyDown={onShortcut(pending, send)}>
      {questions.map((q) => (
        <div key={q.id} className="tx-question">
          {q.header && <div className="tx-q-header">{q.header}</div>}
          <div className="tx-q-text">{q.question}</div>
          <div className="tx-q-options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
            {q.options.map((o) => {
              const on = pending ? (picked[q.id] ?? []).includes(o.label) : (block.answers?.[q.id] ?? '').split(', ').includes(o.label)
              return (
                <button
                  key={o.label}
                  className={`tx-q-option ${on ? 'on' : ''}`}
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={!pending}
                  onClick={() => toggle(q, o.label)}
                >
                  <span className={`tx-q-mark ${q.multiSelect ? 'multi' : ''}`}>{on && <Icon name="check" size={11} />}</span>
                  <span className="tx-q-body">
                    <span className="tx-q-label">{o.label}</span>
                    {o.description && <span className="tx-q-desc">{o.description}</span>}
                  </span>
                </button>
              )
            })}
            {pending && (
              <input className="tx-q-other" placeholder="Something else…" aria-label={`Other answer to: ${q.question}`} value={other[q.id] ?? ''} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} />
            )}
            {!pending && block.answers?.[q.id] && !q.options.length && <div className="tx-q-answer">{block.answers[q.id]}</div>}
          </div>
        </div>
      ))}
      {pending && (
        <div className="tx-ask-actions">
          <button className="tx-ask-btn primary" disabled={!complete} onClick={send} title={complete ? undefined : 'Answer every question first'}>
            Send answers <ShortcutHint />
          </button>
          <button className="tx-ask-btn" onClick={() => onAnswer({ kind: 'deny', message: 'The user skipped these questions.' })}>
            Skip
          </button>
          {!complete && <span className="hint">Answer every question to send</span>}
        </div>
      )}
    </div>
  )
}

export function ApprovalCard({ block, who, root, roomId, memberId, onAnswer }: { block: Approval; who: string; root: string; roomId: string; memberId: string; onAnswer: (d: ApprovalDecision) => void }) {
  const pending = block.status === 'pending'

  if (block.questions?.length) {
    return (
      <div className={`tx-ask ${pending ? 'pending' : 'settled'}`} data-approval={block.id} data-waiting={pending || undefined}>
        <div className="tx-ask-title">
          <Icon name="message" size={14} /> {who} has a question
          {!pending && <span className="tx-ask-done">{DONE_TEXT[block.status]}</span>}
        </div>
        <Questions block={block} questions={block.questions} onAnswer={onAnswer} />
      </div>
    )
  }

  const isPlan = block.toolName === 'ExitPlanMode'
  if (!pending && !isPlan) {
    // Once decided, the activity row already holds the details.
    return (
      <div className={`tx-ask-compact status-${block.status}`}>
        <Icon name={block.status === 'denied' ? 'x' : block.status === 'expired' ? 'alert' : 'check'} size={12} />
        {DONE_TEXT[block.status]}: {block.toolName}
        {block.description ? <span className="tx-ask-compact-desc">{block.description}</span> : null}
      </div>
    )
  }
  const title = isPlan ? `${who} has a plan ready` : CODEX_TITLE[block.toolName] ? `${who} ${CODEX_TITLE[block.toolName]}` : `${who} wants to use ${block.toolName}`
  return <ApprovalPrompt block={block} title={title} isPlan={isPlan} root={root} roomId={roomId} memberId={memberId} onAnswer={onAnswer} />
}

function ApprovalPrompt({ block, title, isPlan, root, roomId, memberId, onAnswer }: { block: Approval; title: string; isPlan: boolean; root: string; roomId: string; memberId: string; onAnswer: (d: ApprovalDecision) => void }) {
  const pending = block.status === 'pending'
  const input = (block.input ?? {}) as Input
  const allow = (): void => onAnswer({ kind: 'allow' })
  useRoomShortcut(block.id, pending, allow)
  return (
    <div className={`tx-ask ${pending ? 'pending' : 'settled'}`} data-approval={block.id} data-waiting={pending || undefined} onKeyDown={onShortcut(pending, allow)}>
      <div className="tx-ask-title">
        <Icon name={isPlan ? 'tasks' : 'shield'} size={14} />
        {title}
        {!pending && <span className="tx-ask-done">{DONE_TEXT[block.status]}</span>}
      </div>
      {block.description && !isPlan && <div className="tx-ask-desc">{block.description}</div>}
      <div className="tx-ask-body approval-body">
        {isPlan ? <Markdown text={str(input.plan)} roomId={roomId} memberId={memberId} /> : <ToolDetails name={block.toolName} input={block.input} root={root} />}
      </div>
      {pending && (
        <div className="tx-ask-actions">
          <button className="tx-ask-btn primary" onClick={allow}>
            {isPlan ? 'Approve plan' : 'Allow once'} <ShortcutHint />
          </button>
          {block.canAlways && !isPlan && (
            <button className="tx-ask-btn" onClick={() => onAnswer({ kind: 'always' })}>
              {block.toolName === 'command' || block.toolName === 'file change' || block.toolName === 'permissions' ? 'Allow for this session' : 'Always allow'}
            </button>
          )}
          <button className="tx-ask-btn" onClick={() => onAnswer({ kind: 'deny', message: isPlan ? 'The user wants to keep planning.' : undefined })}>
            {isPlan ? 'Keep planning' : 'Deny'}
          </button>
        </div>
      )}
    </div>
  )
}
