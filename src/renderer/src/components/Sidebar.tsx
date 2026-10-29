import { useMemo } from 'react'
import type { RoomKind, RoomSummary } from '@shared/types'
import { groupSessions, shortcut, visibleSessions } from '../lib/chrome'
import { deleteSession, setPinned, useStoredList } from '../lib/frame'
import { basename, isBusy } from '../lib/format'
import { useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { AccountsUsage } from './Usage'

const MODES: Array<{ id: RoomKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'team', label: 'Team' }
]

/** Key of the pinned group in the collapsed list; folders are absolute paths, never this. */
const PINNED = 'pinned'

function SessionRow({ room, active }: { room: RoomSummary; active: boolean }) {
  const openRoom = useApp((s) => s.openRoom)
  const statuses = useApp((s) => s.statuses[room.id])
  const values = Object.values(statuses ?? {})
  const busy = values.some((r) => isBusy(r.status))
  const waiting = values.some((r) => r.status === 'waiting')
  return (
    <div className={`sb-session ${active ? 'active' : ''}`}>
      <button className="sb-session-main" onClick={() => void openRoom(room.id)} title={`${room.title}\n${room.folder}`} aria-current={active ? 'page' : undefined}>
        <span className="sb-session-title">{room.title}</span>
        {room.kind === 'team' && (
          <span className="sb-session-marks">
            {room.members.slice(0, 4).map((m) => (
              <AgentMark key={m.id} provider={m.provider} color={m.color} size={12} />
            ))}
          </span>
        )}
        {waiting ? <span className="sb-needs-you" title="Needs you" /> : busy ? <span className="spinner small" title="Working" /> : null}
      </button>
      <span className="sb-session-actions">
        <button className={`icon-btn ${room.pinned ? 'on' : ''}`} title={room.pinned ? 'Unpin' : 'Pin'} onClick={() => setPinned(room.id, !room.pinned)}>
          <Icon name="pin" size={13} />
        </button>
        <button className="icon-btn" title="Delete" onClick={() => deleteSession(room)}>
          <Icon name="trash" size={13} />
        </button>
      </span>
    </div>
  )
}

function SessionGroup({ id, label, title, rooms, collapsed, onToggle, onAdd, current }: {
  id: string
  label: string
  title?: string
  rooms: RoomSummary[]
  collapsed: boolean
  onToggle: (id: string) => void
  onAdd?: () => void
  current?: string
}) {
  const shown = visibleSessions(rooms, collapsed, current)
  return (
    <div className={`sb-group ${collapsed ? 'collapsed' : ''}`}>
      <div className="sb-group-head">
        <button className="sb-group-toggle" aria-expanded={!collapsed} onClick={() => onToggle(id)} title={title}>
          <span className="sb-group-name">{label}</span>
          <Icon name="caretDown" size={10} className="sb-caret" />
          {collapsed && <span className="sb-group-count">{rooms.length}</span>}
        </button>
        {onAdd && (
          <button className="icon-btn sb-group-add" title={`New session in ${label}`} onClick={onAdd}>
            <Icon name="plus" size={13} />
          </button>
        )}
      </div>
      {shown.map((r) => (
        <SessionRow key={r.id} room={r} active={r.id === current} />
      ))}
    </div>
  )
}

export function Sidebar() {
  const rooms = useApp((s) => s.rooms)
  const mode = useApp((s) => s.mode)
  const setMode = useApp((s) => s.setMode)
  const current = useApp((s) => s.currentRoomId)
  const currentFolder = useApp((s) => (s.currentRoomId ? s.roomData[s.currentRoomId]?.folder : undefined))
  const platform = useApp((s) => s.platform)
  const openNewSession = useApp((s) => s.openNewSession)
  const openSettings = useApp((s) => s.openSettings)
  const openRoom = useApp((s) => s.openRoom)
  const setSidebar = useApp((s) => s.setSidebar)
  const setSearchOpen = useApp((s) => s.setSearchOpen)
  const [collapsed, toggle] = useStoredList('iface.collapsedGroups')
  const groups = useMemo(() => groupSessions(rooms, mode), [rooms, mode])

  return (
    <nav className="sidebar sb" aria-label="Sessions">
      <div className="sb-top drag">
        <button className="icon-btn" onClick={() => setSidebar(false)} title={`Hide sidebar (${shortcut(platform, 'B')})`} aria-label="Hide sidebar">
          <Icon name="sidebar" size={16} />
        </button>
        <button className="icon-btn" onClick={() => void openRoom(undefined)} title="Home" aria-label="Home">
          <Icon name="home" size={16} />
        </button>
      </div>
      <div className="sb-nav">
        <button className="sb-nav-row" onClick={() => openNewSession(currentFolder, mode)}>
          <Icon name="plus" size={16} />
          <span>New session</span>
          <kbd>{shortcut(platform, 'N')}</kbd>
        </button>
        <button className="sb-nav-row" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd>{shortcut(platform, 'K')}</kbd>
        </button>
      </div>
      <div className="sb-modes" role="tablist" aria-label="Session type">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="sb-list">
        {groups.pinned.length > 0 && (
          <SessionGroup id={PINNED} label="Pinned" rooms={groups.pinned} collapsed={collapsed.includes(PINNED)} onToggle={toggle} current={current} />
        )}
        {groups.folders.map((g) => (
          <SessionGroup
            key={g.folder}
            id={g.folder}
            label={basename(g.folder)}
            title={g.folder}
            rooms={g.rooms}
            collapsed={collapsed.includes(g.folder)}
            onToggle={toggle}
            onAdd={() => openNewSession(g.folder, mode)}
            current={current}
          />
        ))}
        {!groups.pinned.length && !groups.folders.length && (
          <div className="sb-empty">
            No {MODES.find((m) => m.id === mode)?.label} sessions yet.
            <button className="sb-empty-start" onClick={() => openNewSession(currentFolder, mode)}>Start one</button>
          </div>
        )}
      </div>
      <AccountsUsage />
      <div className="sb-foot">
        <button className="sb-nav-row" onClick={() => openSettings()}>
          <Icon name="settings" size={16} />
          <span>Settings</span>
          <kbd>{shortcut(platform, ',')}</kbd>
        </button>
      </div>
    </nav>
  )
}
