import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import { parseMentions } from '@shared/mentions'
import { PROVIDER_LABEL, defaultRecipients, type Room } from '@shared/types'
import { isBusy } from '../lib/format'
import { act, useApp } from '../store'
import { Composer } from './Composer'
import { AgentMark, Icon } from './Icon'
import { Transcript } from './Transcript'
import { AgentPanes } from './AgentPanes'
import { RoomHeader } from './RoomHeader'
import { canScroll, readRoomLayout, saveRoomLayout, type RoomLayout } from '../lib/agentPanes'

export function RoomView({ room }: { room: Room }) {
  const statuses = useApp((s) => s.statuses[room.id])
  const busy = Object.values(statuses ?? {}).some((r) => isBusy(r.status))
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)
  const team = room.members.length > 1
  const [layoutState, setLayoutState] = useState(() => ({ roomId: room.id, layout: readRoomLayout(room.id) }))
  const layout = layoutState.roomId === room.id ? layoutState.layout : readRoomLayout(room.id)
  const panes = team && layout === 'panes'
  const focusMessageId = useApp((s) => s.focusMessageId)
  const setLayout = (next: RoomLayout): void => {
    setLayoutState({ roomId: room.id, layout: next })
    saveRoomLayout(room.id, next)
  }

  // Search results may belong to any agent, including one hidden by pane focus.
  useLayoutEffect(() => {
    if (focusMessageId && panes) setLayout('chat')
  }, [focusMessageId, room.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useMemo(() => {
    const out = new Set<string>()
    const seen = new Set<string>()
    for (let i = room.messages.length - 1; i >= 0; i--) {
      const m = room.messages[i]
      if (m.author === 'user' || seen.has(m.author)) continue
      seen.add(m.author)
      out.add(m.id)
    }
    return out
  }, [room.messages])

  const setStick = (value: boolean): void => {
    stick.current = value
    setFollowing(value)
  }

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  // A trackpad scrolls a few pixels at a time; stop following new output as soon as the
  // user scrolls up, instead of pulling them back down on the next streamed token. A chat
  // that still fits on screen cannot scroll, so there is nothing to stop following.
  const onWheel = (e: ReactWheelEvent): void => {
    if (e.deltaY < 0 && canScroll(scrollRef.current)) setStick(false)
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setStick(true)
  }

  useLayoutEffect(() => {
    setStick(true)
  }, [room.id])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [room.messages, room.id, panes])

  // Content also grows without a new message (images loading, code highlighting, the
  // composer getting taller): keep following the bottom whenever the user is there.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const follow = (): void => {
      if (stick.current) el.scrollTop = el.scrollHeight
    }
    const observer = new ResizeObserver(follow)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [room.id, panes])

  const examples = team
    ? [
        '@both Read this project and agree on a plan. Put the tasks on the task board, then split the work.',
        `@${room.members[0].handle} build the backend, @${room.members[1].handle} build the UI. Agree on the API first.`,
        `@${room.members[room.members.length - 1].handle} review what the others changed and list problems.`
      ]
    : ['Explain how this project is structured.', 'Find and fix a bug in this project.', room.members[0].provider === 'codex' ? '/review' : '/init']

  return (
    <div className={`room ${panes ? 'room-panes' : ''}`}>
      <RoomHeader room={room} />
      {team && <div className="room-view-bar">
        <div className="segmented room-layout-switch" role="group" aria-label="Conversation layout">
          <button className={!panes ? 'on' : ''} aria-pressed={!panes} onClick={() => setLayout('chat')}><Icon name="list" size={13} /> Shared chat</button>
          <button className={panes ? 'on' : ''} aria-pressed={panes} onClick={() => setLayout('panes')}><Icon name="users" size={13} /> Agent panels</button>
        </div>
        <span className="room-connected-note"><span className="pane-status-dot" />{panes ? 'One room · shared context' : `${room.members.length} connected agents`}</span>
      </div>}
      {panes ? <AgentPanes key={room.id} room={room} latest={latest} busy={busy} /> : <div className="tx-feed">
        <div className="messages" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
          <div className="messages-inner tx-messages">
            {room.messages.length === 0 && (
              <div className="room-empty">
                <div className="room-empty-marks">
                  {room.members.map((m) => (
                    <AgentMark key={m.id} provider={m.provider} color={m.color} size={34} />
                  ))}
                </div>
                <h2>{team ? `${room.members.map((m) => m.name).join(', ')} are ready` : `${room.members[0].name} is ready`}</h2>
                <p>
                  {team
                    ? 'They all work in this folder and read the same conversation. Give the job to one of them, or to everyone, and say who does which part.'
                    : `${PROVIDER_LABEL[room.members[0].provider]} works in this folder, exactly as it does on its own.`}
                </p>
                <div className="examples">
                  {examples.map((ex) => (
                    <button
                      key={ex}
                      className="example"
                      onClick={() => void act(() => window.iface.send(room.id, { text: ex, to: parseMentions(ex, room.members) ?? defaultRecipients(room), attachments: [] }))}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Transcript room={room} messages={room.messages} latest={latest} roomBusy={busy} />
          </div>
        </div>
        {!following && (
          <button className="tx-jump" onClick={jumpToLatest} aria-label="Scroll to the latest message">
            <Icon name="chevronDown" size={14} /> Latest
          </button>
        )}
      </div>}
      {panes && <div className="room-compose-label"><Icon name="users" size={13} /> Message the room<span>Or message one agent in its panel above</span></div>}
      <Composer room={room} busy={busy} />
    </div>
  )
}
