import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import { parseMentions } from '@shared/mentions'
import { PROVIDER_LABEL, activeMemberIds, defaultRecipients, type Member, type Room } from '@shared/types'
import { isBusy, STATUS_TEXT } from '../lib/format'
import { act, useApp, type Panel, EMPTY } from '../store'
import { Composer } from './Composer'
import { AgentMark, Icon, type IconName } from './Icon'
import { ContextRing, Popover } from './MemberControls'
import { MessageView } from './MessageView'
import { ShareChat } from './ShareChat'

function AgentPill({ room, member }: { room: Room; member: Member }) {
  const runtime = useApp((s) => s.statuses[room.id]?.[member.id])
  const status = runtime?.status ?? 'idle'
  const busy = isBusy(status)
  return (
    <span className={`pill status-${status}`} title={`${member.name} (@${member.handle}) · ${PROVIDER_LABEL[member.provider]}${runtime?.detail ? ` · ${runtime.detail}` : ''}${member.worktree ? `\nOwn copy: ${member.worktree.branch}` : ''}`}>
      <AgentMark provider={member.provider} color={member.color} size={16} />
      <span className="pill-name">{member.name}</span>
      <span className="pill-status">
        {busy && <span className="dot-pulse" />}
        {STATUS_TEXT[status]}
        {runtime?.detail && busy ? `: ${runtime.detail}` : ''}
        {runtime?.queued ? ` · ${runtime.queued} queued` : ''}
      </span>
      {room.members.length > 1 && <ContextRing room={room} member={member} />}
      {busy && (
        <button className="pill-stop" title={`Stop ${member.name}`} onClick={() => void window.iface.stop(room.id, member.id)}>
          <Icon name="stop" size={10} />
        </button>
      )}
    </span>
  )
}

function Title({ room }: { room: Room }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(room.title)
  const canceled = useRef(false)
  useEffect(() => setValue(room.title), [room.title])
  if (editing) {
    return (
      <input
        className="title-input"
        aria-label="Session name"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (!canceled.current && value.trim()) void act(() => window.iface.renameRoom(room.id, value.trim()))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            canceled.current = true
            setValue(room.title)
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <div className="room-title-row no-drag"><h1 className="room-title" onDoubleClick={() => { canceled.current = false; setEditing(true) }} title="Double-click to rename">{room.title}</h1>
      <button className="icon-btn tiny" title="Rename session" onClick={() => { canceled.current = false; setEditing(true) }}><Icon name="pencil" size={13} /></button>
    </div>
  )
}

function RoomMenu({ room }: { room: Room }) {
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  return (
    <Popover
      align="right"
      button={(open, toggle) => (
        <button className={`icon-btn ${open ? 'on' : ''}`} onClick={toggle} title="Session settings">
          <Icon name="users" size={16} />
        </button>
      )}
    >
      {() => (
        <div className="model-menu room-menu">
          <div className="menu-title">Agents in this session</div>
          {room.members.map((m) => (
            <div key={m.id} className="menu-row">
              <AgentMark provider={m.provider} color={m.color} size={16} />
              <span className="mi-label">
                {m.name} <span className="handle">@{m.handle}</span>
              </span>
              {room.members.length > 1 && (
                <button className="icon-btn tiny" title="Remove from session" onClick={() => void act(() => window.iface.removeMember(room.id, m.id))}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
          ))}
          <div className="menu-title">Add an agent</div>
          {accounts.map((a) => (
            <button key={a.id} className="menu-item row" onClick={() => void act(() => window.iface.addMember(room.id, a.id))}>
              <AgentMark provider={a.provider} color={a.color} size={14} />
              <span className="mi-label">{a.name}</span>
              <span className="mi-desc">{PROVIDER_LABEL[a.provider]}</span>
            </button>
          ))}
          {room.members.length > 1 && (
            <>
              <div className="menu-title">How the team works</div>
              <label className="dispatch-setting">New messages go to
                <select value={room.dispatch ?? 'parallel'} onChange={(e) => void act(() => window.iface.updateRoom(room.id, { dispatch: e.target.value as 'lead' | 'parallel' }))}>
                  <option value="lead">Lead agent — delegate as needed</option><option value="parallel">All ticked agents — work in parallel</option>
                </select>
              </label>
              {room.dispatch === 'lead' && <label className="dispatch-setting">Lead agent<select value={defaultRecipients(room)[0]} onChange={(e) => void act(() => window.iface.updateRoom(room.id, { leadId: e.target.value }))}>{room.members.filter((m) => activeMemberIds(room).includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
              <div className="panel-note">A lead can give a specialist a task with its own model and effort, then review the result. @mentions still choose recipients directly.</div>
              <div className="menu-title">Hand-offs</div>
              <label className="switch-row small">
                <input type="checkbox" checked={room.autoRelay} onChange={(e) => void window.iface.updateRoom(room.id, { autoRelay: e.target.checked })} />
                <span>
                  Automatic hand-offs
                  <small>When an agent ends with "→ @other", that agent starts right away</small>
                </span>
              </label>
              <label className="inline-number">
                Max hand-offs per message
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={room.maxHops}
                  onChange={(e) => void window.iface.updateRoom(room.id, { maxHops: Number(e.target.value) || 0 })}
                />
              </label>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}

export function RoomView({ room }: { room: Room }) {
  const panel = useApp((s) => s.panel)
  const setPanel = useApp((s) => s.setPanel)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminal = useApp((s) => s.setTerminal)
  const statuses = useApp((s) => s.statuses[room.id])
  const busy = Object.values(statuses ?? {}).some((r) => isBusy(r.status))
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const team = room.members.length > 1

  const panels: Array<{ id: Panel; label: string; icon: IconName }> = [
    { id: 'files', label: 'Files', icon: 'folder' },
    ...(team ? [{ id: 'tasks' as Panel, label: 'Task board', icon: 'tasks' as IconName }] : []),
    { id: 'changes', label: 'Changes and recorded edits', icon: 'diff' },
    { id: 'mcp', label: 'MCP servers', icon: 'plug' }
  ]

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

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  // A trackpad scrolls a few pixels at a time; stop following new output as soon as the
  // user scrolls up, instead of pulling them back down on the next streamed token.
  const onWheel = (e: ReactWheelEvent): void => {
    if (e.deltaY < 0) stick.current = false
  }

  useLayoutEffect(() => {
    stick.current = true
  }, [room.id])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [room.messages, room.id])

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
  }, [room.id])

  const examples = team
    ? [
        '@both Read this project and agree on a plan. Put the tasks on the task board, then split the work.',
        `@${room.members[0].handle} build the backend, @${room.members[1].handle} build the UI. Agree on the API first.`,
        `@${room.members[room.members.length - 1].handle} review what the others changed and list problems.`
      ]
    : ['Explain how this project is structured.', 'Find and fix a bug in this project.', room.members[0].provider === 'codex' ? '/review' : '/init']

  return (
    <div className="room">
      <header className="room-head drag">
        <div className="room-head-main">
          <Title room={room} />
          <button className="folder-link no-drag" title={room.folder} onClick={() => void window.iface.revealPath(room.folder)}>
            <Icon name="folder" size={12} /> {room.folder}
            {room.isolation && <span className="tag ok">separate copies</span>}
          </button>
        </div>
        <div className="room-head-side no-drag">
          <div className="agent-statuses">
          {room.members.map((m) => (
            <AgentPill key={m.id} room={room} member={m} />
          ))}
          </div>
          <span className="head-sep" />
          <ShareChat room={room} />
          <RoomMenu room={room} />
          {panels.map((p) => (
            <button key={p.id} className={`icon-btn ${panel === p.id ? 'on' : ''}`} title={p.label} onClick={() => setPanel(panel === p.id ? null : p.id)}>
              <Icon name={p.icon} size={16} />
            </button>
          ))}
          <button className={`icon-btn ${terminalOpen ? 'on' : ''}`} title="Terminal (Ctrl+`)" onClick={() => setTerminal(!terminalOpen)}>
            <Icon name="terminal" size={16} />
          </button>
        </div>
      </header>
      <div className="messages" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
        <div className="messages-inner">
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
          {room.messages.map((m) => (
            <MessageView key={m.id} message={m} room={room} latestOfAuthor={latest.has(m.id)} roomBusy={busy} />
          ))}
        </div>
      </div>
      <Composer room={room} busy={busy} />
    </div>
  )
}
