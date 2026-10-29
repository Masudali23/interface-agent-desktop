import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { ApprovalDecision, Attachment, Member, Message } from '@shared/types'
import { latestFileActivity } from '@shared/changes'
import { basename, timeOf, usageText } from '../lib/format'
import { liveStep, segmentParts, type AgentItem } from '../lib/timeline'
import { act, useApp } from '../store'
import { ActivityGroup, LiveStatus } from './Activity'
import { ApprovalCard } from './ApprovalCard'
import { AgentMark, Icon } from './Icon'
import { Markdown } from './Markdown'
import { PlanCard } from './PlanCard'
import { useTranscript } from './TranscriptContext'

/** Scrolls to and briefly highlights a message opened from search. */
function useFocusFlash(messageId: string, enabled: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const focus = useApp((s) => enabled && s.focusMessageId === messageId)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    const el = ref.current
    if (!focus || !el) return
    el.scrollIntoView({ block: 'center' })
    // Restart the highlight when the same message is opened again while it still shows.
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    // Clearing the focus re-runs this effect at once, so the timer can't live in its cleanup.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => el.classList.remove('flash'), 2000)
    useApp.setState({ focusMessageId: undefined })
  }, [focus])
  return ref
}

function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
  }]
}

const isImage = (a: Attachment): boolean => a.mime.startsWith('image/')

function UserAttachments({ attachments, roomId }: { attachments: Attachment[]; roomId: string }) {
  const openLink = useApp((s) => s.openLink)
  const open = (a: Attachment) => () => void act(() => openLink(a.path, { roomId }))
  const images = attachments.filter(isImage)
  const files = attachments.filter((a) => !isImage(a))
  return (
    <>
      {images.length > 0 && (
        <div className="tx-user-images">
          {images.map((a) => (
            <button key={a.path} className="tx-thumb" title={`Preview ${a.name}`} onClick={open(a)}>
              <img src={`iface://attachment/${roomId}/${encodeURIComponent(basename(a.path))}`} alt={a.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="tx-user-files">
          {files.map((a) => (
            <button key={a.path} className="tx-file-chip" title={`Preview ${a.name}`} onClick={open(a)}>
              <Icon name="file" size={12} /> <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const { roomId } = useTranscript()
  const messages = useApp((s) => s.roomData[roomId]?.messages)
  const [text, setText] = useState(message.text)
  const [undoFiles, setUndoFiles] = useState(false)
  const later = useMemo(() => {
    const list = messages ?? []
    return list.slice(list.findIndex((m) => m.id === message.id) + 1).filter((m) => m.author !== 'user').length
  }, [messages, message.id])
  const save = async (): Promise<void> => {
    if (!text.trim()) return
    onDone()
    await act(
      () => window.iface.editMessage(roomId, message.id, text.trim(), undoFiles),
      (notes) => (notes ? notes : undefined)
    )
  }
  return (
    <div className="edit-box tx-edit-box">
      <textarea
        autoFocus
        value={text}
        aria-label="Edit message"
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

export const UserMessage = memo(function UserMessage({ message, roomBusy }: { message: Message; roomBusy: boolean }) {
  const { roomId, members, team } = useTranscript()
  const [editing, setEditing] = useState(false)
  const [copied, copy] = useCopy(message.text)
  const ref = useFocusFlash(message.id, true)
  const to = (message.to ?? []).map((id) => members.find((m) => m.id === id)?.name ?? '').filter(Boolean)
  return (
    <div className="tx-user" ref={ref} data-id={message.id}>
      {message.attachments?.length ? <UserAttachments attachments={message.attachments} roomId={roomId} /> : null}
      {editing ? (
        <EditBox message={message} onDone={() => setEditing(false)} />
      ) : (
        message.text && <div className="tx-user-bubble">{message.text}</div>
      )}
      {!editing && (
        <div className="tx-user-meta">
          <span className="tx-user-when">
            {team && to.length ? `to ${to.join(', ')} · ` : ''}
            {timeOf(message.sentAt ?? message.createdAt)}
          </span>
          <button className="icon-btn" onClick={copy} title="Copy" aria-label="Copy message">
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
          {!roomBusy && (
            <button className="icon-btn" onClick={() => setEditing(true)} title="Edit and resend" aria-label="Edit and resend">
              <Icon name="pencil" size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function changedFiles(message: Message): boolean {
  if (message.diff?.trim()) return true
  return message.blocks.some((b) => b.kind === 'tool' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Edit files'].includes(b.name) && b.status === 'done')
}

function AgentHeader({ message, member, name, provider, color }: { message: Message; member?: Member; name: string; provider: 'claude' | 'codex'; color?: string }) {
  const execution = message.execution
  return (
    <div className="tx-agent-head">
      <AgentMark provider={provider} color={color} size={18} />
      <span className="tx-agent-name">{name}</span>
      {member && <span className="tx-agent-handle">@{member.handle}</span>}
      <span className="tx-agent-time">{timeOf(message.createdAt)}</span>
      {message.hop ? <span className="tx-agent-hop">relay {message.hop}</span> : null}
      {execution && (
        <span className="tx-agent-exec" title="Settings when this reply started; later user changes remain saved">
          {execution.model || 'Default model'}
          {execution.effort ? ` · ${execution.effort}` : ''}
          {execution.delegated ? ' · delegated' : ''}
        </span>
      )}
    </div>
  )
}

function AgentFooter({ message, member, provider, latestOfAuthor, roomBusy }: { message: Message; member?: Member; provider: 'claude' | 'codex'; latestOfAuthor: boolean; roomBusy: boolean }) {
  const { roomId, members, maxHops } = useTranscript()
  const openChange = useApp((s) => s.openChange)
  const [copied, copy] = useCopy(message.text)
  const handoff = message.handoff
  const target = handoff && handoff.to !== 'user' && handoff.to !== 'done' ? members.find((m) => m.id === handoff.to) : undefined
  const snap = message.snapshot
  const codexCanUndo = snap?.before && snap.after ? snap.before !== snap.after : !!message.diff
  const changed = changedFiles(message)
  const canUndo = !roomBusy && !message.undone && !message.sharedChanges && (snap?.after ? codexCanUndo : provider === 'codex' ? codexCanUndo : changed && !!message.turn?.start)
  const usage = message.usage ? usageText(message.usage) : undefined
  return (
    <div className="tx-agent-foot">
      {handoff && handoff.to !== 'done' && (
        <span className="tx-handoff" style={target ? ({ '--handoff-color': target.color } as CSSProperties) : undefined}>
          <Icon name="arrowRight" size={12} />
          <b>{handoff.to === 'user' ? 'You' : (target?.name ?? 'agent')}</b>
          {handoff.text && <span className="tx-handoff-text">{handoff.text}</span>}
          {handoff.overrides && <small>{Object.entries(handoff.overrides).map(([key, value]) => `${key}: ${value || 'default'}`).join(' · ')}</small>}
          {handoff.error && <small role="alert">{handoff.error}</small>}
          {target && !message.handoffDone && (message.hop ?? 0) >= maxHops && <small>Automatic hand-off limit reached.</small>}
          {target && !message.handoffDone && message.status === 'done' && (
            <button className="btn tiny" disabled={!!handoff.error && !handoff.invalidSettings} onClick={() => void act(() => window.iface.continueHandoff(roomId, message.id))}>
              Send to {target.name}
            </button>
          )}
        </span>
      )}
      {handoff?.to === 'done' && (
        <span className="tx-handoff done">
          <Icon name="check" size={12} /> Done
        </span>
      )}
      <span className="foot-spacer" />
      <span className="tx-foot-actions">
        {changed && (
          <button className="icon-btn" onClick={() => openChange(latestFileActivity(message)?.path ?? '', message.author, message.id)} title="Review this turn's changes in the side panel" aria-label="Review changes">
            <Icon name="diff" size={13} />
          </button>
        )}
        {canUndo && (
          <button
            className="icon-btn"
            title={provider === 'claude' ? 'Undo: put files back to how they were before this turn' : 'Undo the file changes from this turn'}
            aria-label="Undo file changes"
            onClick={() => {
              if (confirm('Put the files back to how they were before this turn?')) {
                void act(() => window.iface.undoTurn(roomId, message.id), (r) => r)
              }
            }}
          >
            <Icon name="undo" size={13} />
          </button>
        )}
        {latestOfAuthor && member && (
          <button className="icon-btn" title="Retry this reply" aria-label="Retry this reply" onClick={() => void act(() => window.iface.retry(roomId, message.id))}>
            <Icon name="refresh" size={13} />
          </button>
        )}
        {message.text && (
          <button className="icon-btn" onClick={copy} title="Copy reply" aria-label="Copy reply">
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        )}
        {usage && (
          <span className="tx-usage" title={usage.title}>
            {usage.text}
          </span>
        )}
      </span>
    </div>
  )
}

interface SegmentProps {
  item: AgentItem
  /** This is the agent's newest reply (only that one can be retried). */
  latestOfAuthor: boolean
  roomBusy: boolean
  /** Name the agent: the shared chat of a team room, or another agent's turn in a panel. */
  showHeader: boolean
}

/** One part of an agent's turn. A turn you wrote into while it ran has a part before and
 *  a part after your message; the last part carries the plan, live status and footer. */
export const AgentSegment = memo(function AgentSegment({ item, latestOfAuthor, roomBusy, showHeader }: SegmentProps) {
  const { roomId, members, folder } = useTranscript()
  const { message } = item
  const member = members.find((m) => m.id === message.author)
  const name = member?.name ?? message.authorName ?? 'Agent'
  const provider = member?.provider ?? message.provider ?? 'claude'
  const color = member?.color ?? message.color
  const dotColor = provider === 'claude' ? 'var(--claude)' : color
  const live = message.status === 'streaming'
  const root = member?.worktree?.path ?? folder
  const ref = useFocusFlash(message.id, item.isFirst)
  const parts = useMemo(() => segmentParts(item.blocks), [item.blocks])
  const newest = message.blocks[message.blocks.length - 1]
  const steps = useMemo(() => new Map(parts.map((part) => [part.key, part.kind === 'activity' ? liveStep(part.blocks, live, newest) : undefined])), [parts, live, newest])
  const answer = (blockId: string) => (d: ApprovalDecision) => void act(() => window.iface.answer(roomId, message.id, blockId, d))

  return (
    <div className={`tx-agent ${item.isFirst ? 'first' : 'cont'} ${item.isLast ? 'last' : ''}`} ref={ref} data-id={item.isFirst ? message.id : undefined} style={color ? ({ '--agent-color': color } as CSSProperties) : undefined}>
      {showHeader && (item.isFirst ? (
        <AgentHeader message={message} member={member} name={name} provider={provider} color={color} />
      ) : (
        <div className="tx-agent-cont">
          <AgentMark provider={provider} color={color} size={14} />
          <span>{name}</span>
        </div>
      ))}
      {item.plan && <PlanCard plan={item.plan} live={live} />}
      {parts.map((part) => {
        switch (part.kind) {
          case 'text':
            return <Markdown key={part.key} text={part.block.text} roomId={roomId} memberId={message.author} />
          case 'activity':
            return <ActivityGroup key={part.key} blocks={part.blocks} step={steps.get(part.key)} root={root} memberId={message.author} messageId={message.id} color={dotColor} />
          case 'approval':
            return <ApprovalCard key={part.key} block={part.block} who={name} root={root} roomId={roomId} memberId={message.author} onAnswer={answer(part.block.id)} />
          case 'error':
            return (
              <div key={part.key} className="error-block">
                <Icon name="alert" size={14} /> <span>{part.block.text}</span>
              </div>
            )
        }
      })}
      {live && item.isLast && <LiveStatus message={message} roomId={roomId} color={dotColor} />}
      {item.isLast && message.status === 'stopped' && <div className="tx-note">Stopped</div>}
      {item.isLast && message.undone && <div className="tx-note">File changes from this turn were undone</div>}
      {item.isLast && message.sharedChanges && changedFiles(message) && <div className="tx-note">Other agents worked in this folder during this turn. Review changes file by file.</div>}
      {item.isLast && !live && <AgentFooter message={message} member={member} provider={provider} latestOfAuthor={latestOfAuthor} roomBusy={roomBusy} />}
    </div>
  )
})
