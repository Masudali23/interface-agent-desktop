import { useState } from 'react'
import type { ApprovalDecision, Block, Question } from '@shared/types'
import { str } from '../lib/format'
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
  return (
    <div className="questions">
      {questions.map((q) => (
        <div key={q.id} className="question">
          {q.header && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {q.options.map((o) => {
              const on = pending ? (picked[q.id] ?? []).includes(o.label) : (block.answers?.[q.id] ?? '').split(', ').includes(o.label)
              return (
                <button key={o.label} className={`q-option ${on ? 'on' : ''}`} disabled={!pending} onClick={() => toggle(q, o.label)}>
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </button>
              )
            })}
            {pending && (
              <input className="q-other" placeholder="Other…" value={other[q.id] ?? ''} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} />
            )}
            {!pending && block.answers?.[q.id] && !q.options.length && <div className="q-answer">{block.answers[q.id]}</div>}
          </div>
        </div>
      ))}
      {pending && (
        <div className="approval-actions">
          <button className="btn primary" disabled={!complete} onClick={() => onAnswer({ kind: 'answer', answers })} title={complete ? undefined : 'Answer every question first'}>
            Send answers
          </button>
          {!complete && <span className="hint">Answer every question to send</span>}
          <button className="btn" onClick={() => onAnswer({ kind: 'deny', message: 'The user skipped these questions.' })}>
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

export function ApprovalCard({ block, who, root, onAnswer }: { block: Approval; who: string; root: string; onAnswer: (d: ApprovalDecision) => void }) {
  const pending = block.status === 'pending'
  const input = (block.input ?? {}) as Input

  if (block.questions?.length) {
    return (
      <div className={`approval ${pending ? 'pending' : 'settled'}`}>
        <div className="approval-title">
          <Icon name="list" size={14} /> {who} has a question
          {!pending && <span className="approval-done">{DONE_TEXT[block.status]}</span>}
        </div>
        <Questions block={block} questions={block.questions} onAnswer={onAnswer} />
      </div>
    )
  }

  const isPlan = block.toolName === 'ExitPlanMode'
  if (!pending && !isPlan) {
    // Once decided, the tool row above already shows the details.
    return (
      <div className={`approval-compact status-${block.status}`}>
        <Icon name={block.status === 'denied' ? 'x' : block.status === 'expired' ? 'alert' : 'check'} size={12} />
        {DONE_TEXT[block.status]}: {block.toolName}
        {block.description ? <span className="approval-compact-desc">{block.description}</span> : null}
      </div>
    )
  }
  const title = isPlan ? `${who} has a plan ready` : CODEX_TITLE[block.toolName] ? `${who} ${CODEX_TITLE[block.toolName]}` : `${who} wants to use ${block.toolName}`
  return (
    <div className={`approval ${pending ? 'pending' : 'settled'}`}>
      <div className="approval-title">
        <Icon name={isPlan ? 'tasks' : 'shield'} size={14} />
        {title}
        {!pending && <span className="approval-done">{DONE_TEXT[block.status]}</span>}
      </div>
      {block.description && !isPlan && <div className="approval-desc">{block.description}</div>}
      <div className="approval-body">
        {isPlan ? <Markdown text={str(input.plan)} /> : <ToolDetails name={block.toolName} input={block.input} root={root} />}
      </div>
      {pending && (
        <div className="approval-actions">
          <button className="btn primary" onClick={() => onAnswer({ kind: 'allow' })}>
            {isPlan ? 'Approve plan' : 'Allow once'}
          </button>
          {block.canAlways && !isPlan && (
            <button className="btn" onClick={() => onAnswer({ kind: 'always' })}>
              {block.toolName === 'command' || block.toolName === 'file change' || block.toolName === 'permissions' ? 'Allow for this session' : 'Always allow'}
            </button>
          )}
          <button className="btn" onClick={() => onAnswer({ kind: 'deny', message: isPlan ? 'The user wants to keep planning.' : undefined })}>
            {isPlan ? 'Keep planning' : 'Deny'}
          </button>
        </div>
      )}
    </div>
  )
}
