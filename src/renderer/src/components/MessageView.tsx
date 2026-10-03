import { memo, useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, Message, Room } from '@shared/types'
import { latestFileActivity } from '@shared/changes'
import { basename, timeOf, usageText } from '../lib/format'
import { act, useApp } from '../store'
import { ApprovalCard } from './ApprovalCard'
import { AgentMark, Icon } from './Icon'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

interface Props {
  message: Message
  room: Room
  /** This is the agent's newest reply (only that one can be retried). */
  latestOfAuthor: boolean
  roomBusy: boolean
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon name="brain" size={13} />
        {live ? 'Thinking…' : 'Thought process'}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function Attachments({ message, roomId }: { message: Message; roomId: string }) {
  const openLink = useApp((s) => s.openLink)
  if (!message.attachments?.length) return null
  return (
    <div className="msg-attachments">
      {message.attachments.map((a) =>
        a.mime.startsWith('image/') ? (
          <button key={a.path} className="attachment-preview" title={`Preview ${a.name}`} onClick={() => void act(() => openLink(a.path, { roomId }))}>
            <img src={`iface://attachment/${roomId}/${encodeURIComponent(basename(a.path))}`} alt={a.name} />
          </button>
        ) : (
          <button key={a.path} className="file-chip" title={`Preview ${a.name}`} onClick={() => void act(() => openLink(a.path, { roomId }))}>
            <Icon name="file" size={12} /> {a.name}
          </button>
        )
      )}
    </div>
  )
}

function EditBox({ message, room, onDone }: { message: Message; room: Room; onDone: () => void }) {
  const [text, setText] = useState(message.text)
  const [undoFiles, setUndoFiles] = useState(false)
  const later = room.messages.slice(room.messages.findIndex((m) => m.id === message.id) + 1).filter((m) => m.author !== 'user').length
  const save = async (): Promise<void> => {
    if (!text.trim()) return
    onDone()
    await act(
      () => window.iface.editMessage(room.id, message.id, text.trim(), undoFiles),
      (notes) => (notes ? notes : undefined)
    )
  }
  return (
    <div className="edit-box">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
          if (e.key === 'Escape') onDone()
        }}
      />
      {later > 0 && (
        <label className="switch-row small">
          <input type="checkbox" checked={undoFiles} onChange={(e) => setUndoFiles(e.target.checked)} />
          <span>
            Also undo file changes made after this message
            <small>{later} later repl{later === 1 ? 'y is' : 'ies are'} removed, and each agent continues from before this message.</small>
          </span>
        </label>
      )}
      <div className="edit-actions">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()}>
          Save and resend
        </button>
      </div>
    </div>
  )
}

function changedFiles(message: Message): boolean {
  if (message.diff?.trim()) return true
  return message.blocks.some((b) => b.kind === 'tool' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Edit files'].includes(b.name) && b.status === 'done')
}

export const MessageView = memo(function MessageView({ message, room, latestOfAuthor, roomBusy }: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const openChange = useApp((s) => s.openChange)
  const focus = useApp((s) => s.focusMessageId === message.id)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus || !ref.current) return
    ref.current.scrollIntoView({ block: 'center' })
    ref.current.classList.add('flash')
    const t = setTimeout(() => ref.current?.classList.remove('flash'), 2000)
    useApp.setState({ focusMessageId: undefined })
    return () => clearTimeout(t)
  }, [focus])

  const copy = (): void => {
    void navigator.clipboard.writeText(message.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  if (message.author === 'user') {
    const to = (message.to ?? []).map((id) => room.members.find((m) => m.id === id)?.name ?? '').filter(Boolean)
    return (
      <div className="msg msg-user" ref={ref} data-id={message.id}>
        <div className="user-meta">
          {room.members.length > 1 && to.length ? `to ${to.join(', ')} · ` : ''}
          {timeOf(message.createdAt)}
        </div>
        {editing ? (
          <EditBox message={message} room={room} onDone={() => setEditing(false)} />
        ) : (
          <div className="user-bubble">
            <Attachments message={message} roomId={room.id} />
            <div className="user-text">{message.text}</div>
          </div>
        )}
        {!editing && (
          <div className="msg-actions">
            <button className="icon-btn" onClick={copy} title="Copy">
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
            {!roomBusy && (
              <button className="icon-btn" onClick={() => setEditing(true)} title="Edit and resend">
                <Icon name="pencil" size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const member = room.members.find((m) => m.id === message.author)
  const name = member?.name ?? message.authorName ?? 'Agent'
  const provider = member?.provider ?? message.provider ?? 'claude'
  const color = member?.color ?? message.color
  const live = message.status === 'streaming'
  const answer = (blockId: string) => (d: ApprovalDecision) => void act(() => window.iface.answer(room.id, message.id, blockId, d))
  const handoff = message.handoff
  const target = handoff && handoff.to !== 'user' && handoff.to !== 'done' ? room.members.find((m) => m.id === handoff.to) : undefined
  const lastBlock = message.blocks.length ? message.blocks[message.blocks.length - 1].id : ''
  const snap = message.snapshot
  const codexCanUndo = snap?.before && snap.after ? snap.before !== snap.after : !!message.diff
  const canUndo = !live && !roomBusy && !message.undone && !message.sharedChanges && (snap?.after ? codexCanUndo : provider === 'codex' ? codexCanUndo : changedFiles(message) && !!message.turn?.start)
  const root = member?.worktree?.path ?? room.folder

  return (
    <div className={`msg msg-agent`} ref={ref} data-id={message.id}>
      <div className="agent-head">
        <AgentMark provider={provider} color={color} size={22} />
        <span className="agent-name" style={{ color }}>
          {name}
        </span>
        {room.members.length > 1 && member && <span className="handle">@{member.handle}</span>}
        <span className="agent-time">{timeOf(message.createdAt)}</span>
        {message.hop ? <span className="hop">relay {message.hop}</span> : null}
        {message.execution && <span className="execution-note" title="Settings when this reply started; later user changes remain saved">{message.execution.model || 'Default model'}{message.execution.effort ? ` · ${message.execution.effort}` : ''}{message.execution.delegated ? ' · delegated' : ''}</span>}
        {live && <span className="spinner" />}
      </div>
      <div className="agent-body">
        {message.blocks.map((b) => {
          switch (b.kind) {
            case 'text':
              return b.text.trim() ? <Markdown key={b.id} text={b.text} roomId={room.id} memberId={message.author === 'user' ? undefined : message.author} /> : null
            case 'thinking':
              return <Thinking key={b.id} text={b.text} live={live && b.id === lastBlock} />
            case 'tool':
              return <ToolCard key={b.id} block={b} root={root} memberId={message.author} messageId={message.id} />
            case 'approval':
              return <ApprovalCard key={b.id} block={b} who={name} root={root} roomId={room.id} memberId={message.author} onAnswer={answer(b.id)} />
            case 'error':
              return (
                <div key={b.id} className="error-block">
                  <Icon name="alert" size={14} /> <span>{b.text}</span>
                </div>
              )
          }
        })}
        {live && !message.blocks.length && <div className="placeholder-line">Working…</div>}
        {message.status === 'stopped' && <div className="stopped-note">Stopped</div>}
        {message.undone && <div className="stopped-note">File changes from this turn were undone</div>}
        {message.sharedChanges && changedFiles(message) && <div className="stopped-note">Other agents worked in this folder during this turn. Review changes file by file.</div>}
      </div>
      {!live && (
        <div className="agent-foot">
          {handoff && handoff.to !== 'done' && (
            <span className="handoff" style={target ? { background: `${target.color}22` } : undefined}>
              <Icon name="arrowRight" size={12} />
              <b>{handoff.to === 'user' ? 'You' : (target?.name ?? 'agent')}</b>
              {handoff.text && <span className="handoff-text">{handoff.text}</span>}
              {handoff.overrides && <small>{Object.entries(handoff.overrides).map(([key, value]) => `${key}: ${value || 'default'}`).join(' · ')}</small>}
              {handoff.error && <small role="alert">{handoff.error}</small>}
              {target && !message.handoffDone && (message.hop ?? 0) >= room.maxHops && <small>Automatic hand-off limit reached.</small>}
              {target && !message.handoffDone && message.status === 'done' && (
                <button className="btn tiny" disabled={!!handoff.error && !handoff.invalidSettings} onClick={() => void act(() => window.iface.continueHandoff(room.id, message.id))}>
                  Send to {target.name}
                </button>
              )}
            </span>
          )}
          {handoff?.to === 'done' && (
            <span className="handoff handoff-done">
              <Icon name="check" size={12} /> Done
            </span>
          )}
          <span className="foot-spacer" />
          {message.usage && (
            <span className="usage-note" title={usageText(message.usage).title}>
              {usageText(message.usage).text}
            </span>
          )}
          <span className="msg-actions inline">
            {changedFiles(message) && (
              <button className="icon-btn" onClick={() => openChange(latestFileActivity(message)?.path ?? '', message.author, message.id)} title="Review this turn's changes in the side panel">
                <Icon name="diff" size={13} />
              </button>
            )}
            {canUndo && (
              <button
                className="icon-btn"
                title={provider === 'claude' ? 'Undo: put files back to how they were before this turn' : 'Undo the file changes from this turn'}
                onClick={() => {
                  if (confirm('Put the files back to how they were before this turn?')) {
                    void act(() => window.iface.undoTurn(room.id, message.id), (r) => r)
                  }
                }}
              >
                <Icon name="undo" size={13} />
              </button>
            )}
            {latestOfAuthor && member && (
              <button className="icon-btn" title="Retry this reply" onClick={() => void act(() => window.iface.retry(room.id, message.id))}>
                <Icon name="refresh" size={13} />
              </button>
            )}
            {message.text && (
              <button className="icon-btn" onClick={copy} title="Copy reply">
                <Icon name={copied ? 'check' : 'copy'} size={13} />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
})
