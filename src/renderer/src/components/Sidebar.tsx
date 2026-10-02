import { useMemo } from 'react'
import type { RoomKind, RoomSummary } from '@shared/types'
import { ago, basename, isBusy } from '../lib/format'
import { act, useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { AccountsUsage } from './Usage'

const MODES: Array<{ id: RoomKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'team', label: 'Team' }
]

function RoomRow({ room, active }: { room: RoomSummary; active: boolean }) {
  const openRoom = useApp((s) => s.openRoom)
  const statuses = useApp((s) => s.statuses[room.id])
  const values = Object.values(statuses ?? {})
  const busy = values.some((r) => isBusy(r.status))
  const waiting = values.some((r) => r.status === 'waiting')
  const remove = (): void => {
    if (confirm(`Delete "${room.title}"? The conversation is removed from this app, and agent copies (worktrees) that weren't merged are deleted. Your project files stay.`)) {
      void act(() => window.iface.deleteRoom(room.id))
    }
  }
  return (
    <div className={`room-row ${active ? 'active' : ''}`}>
      <button className="room-row-main" onClick={() => void openRoom(room.id)} title={`${room.title}\n${room.folder}`}>
        {waiting ? <span className="badge-wait" title="Needs you" /> : busy ? <span className="spinner small" /> : null}
        <span className="room-row-title">{room.title}</span>
        {room.kind === 'team' && (
          <span className="row-marks">
            {room.members.slice(0, 4).map((m) => (
              <AgentMark key={m.id} provider={m.provider} color={m.color} size={12} />
            ))}
          </span>
        )}
      </button>
      <span className="room-row-actions">
        <button className={`icon-btn ${room.pinned ? 'on' : ''}`} title={room.pinned ? 'Unpin' : 'Pin'} onClick={() => void window.iface.pinRoom(room.id, !room.pinned)}>
          <Icon name="pin" size={13} />
        </button>
        <button className="icon-btn" title="Delete" onClick={remove}>
          <Icon name="trash" size={13} />
        </button>
      </span>
    </div>
  )
}

function SearchResults() {
  const hits = useApp((s) => s.searchHits)
  const query = useApp((s) => s.searchQuery)
  const openRoom = useApp((s) => s.openRoom)
  if (!hits.length) return <div className="sidebar-empty">No messages match "{query}".</div>
  return (
    <div className="search-hits">
      {hits.map((h) => (
        <button key={h.messageId} className="search-hit" onClick={() => void openRoom(h.roomId, h.messageId)}>
          <div className="hit-head">
            <span className="hit-room">{h.roomTitle}</span>
            <span className="hit-time">{ago(h.createdAt)}</span>
          </div>
          <div className="hit-snippet">
            <b>{h.author}:</b> {h.snippet}
          </div>
        </button>
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
  const openNewSession = useApp((s) => s.openNewSession)
  const openSettings = useApp((s) => s.openSettings)
  const openRoom = useApp((s) => s.openRoom)
  const query = useApp((s) => s.searchQuery)
  const search = useApp((s) => s.search)

  const groups = useMemo(() => {
    const list = rooms.filter((r) => r.kind === mode)
    const pinned = list.filter((r) => r.pinned)
    const byFolder = new Map<string, RoomSummary[]>()
    for (const r of list.filter((x) => !x.pinned)) byFolder.set(r.folder, [...(byFolder.get(r.folder) ?? []), r])
    return { pinned, folders: [...byFolder.entries()] }
  }, [rooms, mode])

  const searching = query.trim().length >= 2

  return (
    <nav className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand no-drag" onClick={() => void openRoom(undefined)} title="Home">
          Interface
        </span>
      </div>
      <div className="mode-switch" role="tablist">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="sidebar-actions">
        <button className="new-room" onClick={() => openNewSession(currentFolder, mode)} title="New session (Ctrl/Cmd+N)">
          <Icon name="plus" size={15} /> New session
        </button>
      </div>
      <div className="search">
        <Icon name="search" size={13} />
        <input id="sidebar-search" placeholder="Search all messages" value={query} onChange={(e) => void search(e.target.value)} />
        {query && (
          <button className="icon-btn tiny" onClick={() => void search('')} title="Clear">
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      <div className="room-list">
        {searching ? (
          <SearchResults />
        ) : (
          <>
            {groups.pinned.length > 0 && (
              <div className="room-group">
                <div className="group-title">Pinned</div>
                {groups.pinned.map((r) => (
                  <RoomRow key={r.id} room={r} active={r.id === current} />
                ))}
              </div>
            )}
            {groups.folders.map(([folder, list]) => (
              <div key={folder} className="room-group">
                <div className="group-title" title={folder}>
                  <Icon name="folder" size={12} /> {basename(folder)}
                  <button className="icon-btn group-add" title={`New session in ${basename(folder)}`} onClick={() => openNewSession(folder, mode)}>
                    <Icon name="plus" size={12} />
                  </button>
                </div>
                {list.map((r) => (
                  <RoomRow key={r.id} room={r} active={r.id === current} />
                ))}
              </div>
            ))}
            {!groups.pinned.length && !groups.folders.length && (
              <div className="sidebar-empty">No {MODES.find((m) => m.id === mode)?.label} sessions yet.</div>
            )}
          </>
        )}
      </div>
      <AccountsUsage />
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => openSettings()}>
          <Icon name="settings" size={15} /> Settings
        </button>
      </div>
    </nav>
  )
}
