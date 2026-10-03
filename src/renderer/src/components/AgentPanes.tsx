import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { activeMemberIds, PROVIDER_LABEL, type Member, type Room } from '@shared/types'
import { paneMessages } from '../lib/agentPanes'
import { isBusy, STATUS_TEXT } from '../lib/format'
import { useApp } from '../store'
import { Composer } from './Composer'
import { AgentMark, Icon } from './Icon'
import { ContextRing, ModelMenu, ModeMenu } from './MemberControls'
import { MessageView } from './MessageView'

function AgentPane({ room, member, latest, roomBusy, expanded, onExpand }: {
  room: Room; member: Member; latest: Set<string>; roomBusy: boolean; expanded: boolean; onExpand(): void
}) {
  const runtime = useApp((s) => s.statuses[room.id]?.[member.id])
  const status = runtime?.status ?? 'idle'
  const busy = isBusy(status)
  const selected = activeMemberIds(room).includes(member.id)
  const messages = useMemo(() => paneMessages(room.messages, member.id), [room.messages, member.id])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)

  const follow = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setFollowing(true)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, expanded])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [])

  return (
    <section className={`agent-pane status-${status}`} aria-label={`${member.name} panel`} style={{ '--pane-color': member.color } as CSSProperties}>
      <header className="agent-pane-head">
        <div className="agent-pane-identity">
          <AgentMark provider={member.provider} color={member.color} size={28} />
          <div className="agent-pane-name"><strong>{member.name}</strong><span>@{member.handle} · {PROVIDER_LABEL[member.provider]}</span></div>
          <ContextRing room={room} member={member} />
          <button className="icon-btn" onClick={onExpand} title={expanded ? 'Show all agent panels' : `Expand ${member.name} panel`} aria-pressed={expanded}>
            <Icon name={expanded ? 'users' : 'panelRight'} size={15} />
          </button>
        </div>
        <div className="agent-pane-status">
          {busy ? <span className="dot-pulse" /> : <span className="pane-status-dot" />}
          <span title={runtime?.detail}>{STATUS_TEXT[status]}{runtime?.detail && busy ? ` · ${runtime.detail}` : ''}{runtime?.queued ? ` · ${runtime.queued} queued` : ''}</span>
          {!selected && <span className="pane-paused">Not ticked</span>}
        </div>
        <div className="agent-pane-controls"><ModelMenu room={room} member={member} portal /><ModeMenu room={room} member={member} portal /></div>
      </header>
      <div className="agent-pane-feed">
        <div className="agent-pane-messages" ref={scrollRef} tabIndex={0} aria-label={`${member.name} conversation`}
          onScroll={() => {
            const el = scrollRef.current
            if (!el) return
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            setFollowing(stick.current)
          }}
          onWheel={(event) => { if (event.deltaY < 0) { stick.current = false; setFollowing(false) } }}>
          <div className="agent-pane-messages-inner">
            {messages.length === 0 && <div className="agent-pane-empty"><AgentMark provider={member.provider} color={member.color} size={34} /><strong>Ready when you are</strong><p>Message {member.name} below, or use the room composer to coordinate the team.</p></div>}
            {messages.map((message) => message.author !== 'user' && message.author !== member.id ? (
              <details key={message.id} className="pane-handoff">
                <summary><Icon name="arrowRight" size={13} /><span>From {room.members.find((m) => m.id === message.author)?.name ?? message.authorName ?? 'another agent'}<small>{message.handoff?.text || 'Shared an update'}</small></span></summary>
                <MessageView message={message} room={room} latestOfAuthor={latest.has(message.id)} roomBusy={roomBusy} />
              </details>
            ) : <MessageView key={message.id} message={message} room={room} latestOfAuthor={latest.has(message.id)} roomBusy={roomBusy} />)}
          </div>
        </div>
        {!following && <button className="pane-jump" onClick={follow}><Icon name="chevronDown" size={12} /> Latest messages</button>}
      </div>
      <Composer room={room} busy={busy} memberId={member.id} />
    </section>
  )
}

export function AgentPanes({ room, latest, busy }: { room: Room; latest: Set<string>; busy: boolean }) {
  const [focused, setFocused] = useState<string>()
  const focus = room.members.some((m) => m.id === focused) ? focused : undefined
  return (
    <div className={`agent-panes-grid ${focus ? 'pane-focused' : ''}`} aria-label="Connected agent panels">
      {room.members.map((member) => (
        <div className="agent-pane-slot" key={member.id} hidden={!!focus && focus !== member.id}>
          <AgentPane room={room} member={member} latest={latest} roomBusy={busy} expanded={focus === member.id} onExpand={() => setFocused(focus === member.id ? undefined : member.id)} />
        </div>
      ))}
    </div>
  )
}
