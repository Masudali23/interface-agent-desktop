import { useEffect, useRef, useState } from 'react'
import { PROVIDER_LABEL, activeMemberIds, defaultRecipients, type Member, type Room } from '@shared/types'
import { stopAgents } from '../lib/actions'
import { deleteSession, setPinned, showFolder, showFolderLabel } from '../lib/frame'
import { basename, isBusy, STATUS_TEXT } from '../lib/format'
import { act, useApp, type Panel, EMPTY } from '../store'
import { AgentMark, Icon, type IconName } from './Icon'
import { Popover } from './MemberControls'
import { ChatExportItems, useChatExport } from './ShareChat'

/** Avatar with a status dot; hovering a working agent offers its stop button. */
function AgentPill({ room, member }: { room: Room; member: Member }) {
  const runtime = useApp((s) => s.statuses[room.id]?.[member.id])
  const status = runtime?.status ?? 'idle'
  const busy = isBusy(status)
  const title = [
    `${member.name} (@${member.handle}) · ${PROVIDER_LABEL[member.provider]}`,
    `${STATUS_TEXT[status]}${runtime?.detail ? `: ${runtime.detail}` : ''}${runtime?.queued ? ` · ${runtime.queued} queued` : ''}`,
    member.worktree ? `Own copy: ${member.worktree.branch}` : ''
  ].filter(Boolean).join('\n')
  return (
    <span className={`ch-pill status-${status}`} title={title}>
      <span className="ch-pill-mark">
        <AgentMark provider={member.provider} color={member.color} size={18} />
        <span className="ch-pill-dot" />
      </span>
      <span className="ch-pill-name">{member.name}</span>
      {busy && (
        <button className="ch-pill-stop" title={`Stop ${member.name}`} aria-label={`Stop ${member.name}`} onClick={() => void stopAgents(room.id, member.id)}>
          <Icon name="stop" size={9} />
        </button>
      )}
    </span>
  )
}

function TitleInput({ room, done }: { room: Room; done: () => void }) {
  const [value, setValue] = useState(room.title)
  const canceled = useRef(false)
  return (
    <input
      className="ch-title-input no-drag"
      aria-label="Session name"
      autoFocus
      onFocus={(e) => e.target.select()}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        done()
        if (!canceled.current && value.trim() && value.trim() !== room.title) void act(() => window.iface.renameRoom(room.id, value.trim()))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          canceled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** The session title and its menu: rename, pin, reveal, share or export, delete. */
function SessionTitle({ room }: { room: Room }) {
  const platform = useApp((s) => s.platform)
  const [editing, setEditing] = useState(false)
  const exporter = useChatExport(room)
  useEffect(() => setEditing(false), [room.id])
  if (editing) return <TitleInput room={room} done={() => setEditing(false)} />
  return (
    <Popover
      className="ch-title-anchor no-drag"
      button={(open, toggle) => (
        <button className={`ch-title ${open ? 'on' : ''}`} onClick={toggle} onDoubleClick={() => setEditing(true)} title={`${room.title}\nDouble-click to rename`} aria-haspopup="menu" aria-expanded={open}>
          <span className="ch-title-text">{room.title}</span>
          {exporter.working ? <span className="spinner small" title="Exporting…" /> : <Icon name="chevronDown" size={14} />}
        </button>
      )}
    >
      {(close) => (
        <div className="model-menu ch-menu" role="menu">
          <button className="menu-item row" onClick={() => { close(); setEditing(true) }}>
            <Icon name="pencil" size={14} /><span className="mi-label">Rename</span>
          </button>
          <button className="menu-item row" onClick={() => { close(); setPinned(room.id, !room.pinned) }}>
            <Icon name="pin" size={14} /><span className="mi-label">{room.pinned ? 'Unpin' : 'Pin'}</span>
          </button>
          <button className="menu-item row" onClick={() => { close(); showFolder(platform, room.folder) }}>
            <Icon name="folderOpen" size={14} /><span className="mi-label">{showFolderLabel(platform)}</span>
          </button>
          <div className="ch-menu-sep" />
          <div className="menu-title">Share this chat</div>
          <ChatExportItems platform={platform} working={exporter.working} run={exporter.run} close={close} />
          <div className="ch-menu-sep" />
          <button className="menu-item row ch-danger" onClick={() => { close(); deleteSession(room) }}>
            <Icon name="trash" size={14} /><span className="mi-label">Delete session</span>
          </button>
        </div>
      )}
    </Popover>
  )
}

/** Agents, team dispatch and hand-off settings. */
function MoreMenu({ room }: { room: Room }) {
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  return (
    <Popover
      align="right"
      button={(open, toggle) => (
        <button className={`icon-btn ${open ? 'on' : ''}`} onClick={toggle} title="Agents and team settings" aria-label="More">
          <Icon name="dots" size={16} />
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
          {!accounts.length && <div className="menu-empty">Add accounts in Settings to bring more agents in.</div>}
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
                <input type="checkbox" checked={room.autoRelay} onChange={(e) => void act(() => window.iface.updateRoom(room.id, { autoRelay: e.target.checked }))} />
                <span>
                  Automatic hand-offs
                  <small>When an agent ends with "→ @other", the hand-off joins that agent's work or starts its next turn</small>
                </span>
              </label>
              <label className="inline-number">
                Max hand-offs per message
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={room.maxHops}
                  onChange={(e) => void act(() => window.iface.updateRoom(room.id, { maxHops: Number(e.target.value) || 0 }))}
                />
              </label>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}

export function RoomHeader({ room }: { room: Room }) {
  const platform = useApp((s) => s.platform)
  const panel = useApp((s) => s.panel)
  const preview = useApp((s) => s.preview)
  const setPanel = useApp((s) => s.setPanel)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminal = useApp((s) => s.setTerminal)
  const team = room.members.length > 1
  const panels: Array<{ id: Panel; label: string; icon: IconName }> = [
    { id: 'session', label: 'Session overview', icon: 'panelRight' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'changes', label: 'Changes and recorded edits', icon: 'diff' },
    ...(team ? [{ id: 'tasks' as Panel, label: 'Task board', icon: 'tasks' as IconName }] : []),
    { id: 'mcp', label: 'MCP servers', icon: 'plug' }
  ]

  return (
    <header className="room-head ch-head drag">
      <div className="ch-head-main">
        <SessionTitle room={room} />
        <button className="ch-folder no-drag" title={`${room.folder}\n${showFolderLabel(platform)}`} onClick={() => showFolder(platform, room.folder)}>
          {basename(room.folder)}
        </button>
        {room.isolation && <span className="tag ok ch-tag" title="Each agent works in its own git worktree">separate copies</span>}
      </div>
      <div className="ch-head-side no-drag">
        {team && (
          <div className="ch-pills">
            {room.members.map((m) => (
              <AgentPill key={m.id} room={room} member={m} />
            ))}
          </div>
        )}
        <div className="ch-tools">
          {panels.map((p) => {
            const on = panel === p.id && !preview
            return (
              <button key={p.id} className={`icon-btn ${on ? 'on' : ''}`} title={p.label} aria-label={p.label} aria-pressed={on} onClick={() => setPanel(on ? null : p.id)}>
                <Icon name={p.icon} size={16} />
              </button>
            )
          })}
          <button className={`icon-btn ${terminalOpen ? 'on' : ''}`} title="Terminal (Ctrl+`)" aria-label="Terminal" aria-pressed={terminalOpen} onClick={() => setTerminal(!terminalOpen)}>
            <Icon name="terminal" size={16} />
          </button>
          <MoreMenu room={room} />
        </div>
      </div>
    </header>
  )
}
