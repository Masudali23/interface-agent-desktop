import { useMemo } from 'react'
import type { RoomKind, RoomSummary } from '@shared/types'
import { projectGroups, shortcut, visibleSessions, type ProjectGroup } from '../lib/chrome'
import { deleteSession, setPinned, showFolder, showFolderLabel, useStoredList } from '../lib/frame'
import { basename, isBusy } from '../lib/format'
import { act, useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'
import { Popover } from './MemberControls'
import { AccountsUsage } from './Usage'

const MODES: Array<{ id: RoomKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'team', label: 'Team' }
]

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
        {room.pinned && <Icon name="pin" size={11} className="sb-pinned" />}
        {waiting ? <span className="sb-needs-you" title="Needs you" /> : busy ? <span className="spinner small" title="Working" /> : null}
      </button>
      <span className="sb-session-actions">
        <button className={`icon-btn ${room.pinned ? 'on' : ''}`} title={room.pinned ? 'Unpin' : 'Pin to the top of its project'} onClick={() => setPinned(room.id, !room.pinned)}>
          <Icon name="pin" size={13} />
        </button>
        <button className="icon-btn" title="Delete" onClick={() => deleteSession(room)}>
          <Icon name="trash" size={13} />
        </button>
      </span>
    </div>
  )
}

/** Start a session in the project, show its folder, copy its path or take it off the list. */
function ProjectMenu({ project, onNew }: { project: ProjectGroup; onNew: () => void }) {
  const platform = useApp((s) => s.platform)
  const removeProject = useApp((s) => s.removeProject)
  const name = basename(project.folder)
  return (
    <Popover
      portal
      button={(open, toggle) => (
        <button className={`icon-btn sb-group-btn ${open ? 'on' : ''}`} onClick={toggle} title="More" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open}>
          <Icon name="dots" size={14} />
        </button>
      )}
    >
      {(close) => (
        <div className="model-menu ch-menu" role="menu">
          <button className="menu-item row" onClick={() => { close(); onNew() }}>
            <Icon name="plus" size={14} /><span className="mi-label">New session</span>
          </button>
          <button className="menu-item row" onClick={() => { close(); showFolder(platform, project.folder) }}>
            <Icon name="folderOpen" size={14} /><span className="mi-label">{showFolderLabel(platform)}</span>
          </button>
          <button className="menu-item row" onClick={() => { close(); void act(() => navigator.clipboard.writeText(project.folder), () => 'Path copied') }}>
            <Icon name="copy" size={14} /><span className="mi-label">Copy path</span>
          </button>
          <div className="ch-menu-sep" />
          <button
            className="menu-item row ch-danger"
            disabled={project.total > 0}
            title={project.total > 0 ? 'Delete the sessions in this project first' : 'Your files stay where they are'}
            onClick={() => { close(); void removeProject(project.folder) }}
          >
            <Icon name="x" size={14} /><span className="mi-label">Remove project</span>
          </button>
        </div>
      )}
    </Popover>
  )
}

/** A project with the chosen type's sessions under it, like the Claude desktop sidebar. */
function ProjectSection({ project, mode, collapsed, onToggle, current }: {
  project: ProjectGroup
  mode: RoomKind
  collapsed: boolean
  onToggle: (folder: string) => void
  current?: string
}) {
  const openNewSession = useApp((s) => s.openNewSession)
  const name = basename(project.folder)
  const modeLabel = MODES.find((m) => m.id === mode)?.label
  const shown = visibleSessions(project.rooms, collapsed, current)
  const startNew = (): void => openNewSession(project.folder, mode)
  return (
    <div className={`sb-group ${collapsed ? 'collapsed' : ''}`}>
      <div className="sb-group-head">
        <button className="sb-group-toggle" aria-expanded={!collapsed} onClick={() => onToggle(project.folder)} title={project.folder}>
          <span className="sb-group-name">{name}</span>
          <Icon name="caretDown" size={10} className="sb-caret" />
          {collapsed && project.rooms.length > 0 && <span className="sb-group-count">{project.rooms.length}</span>}
        </button>
        <span className="sb-group-actions">
          <button className="icon-btn sb-group-btn" title={`New ${modeLabel} session in ${name}`} aria-label={`New session in ${name}`} onClick={startNew}>
            <Icon name="plus" size={13} />
          </button>
          <ProjectMenu project={project} onNew={startNew} />
        </span>
      </div>
      {shown.map((r) => (
        <SessionRow key={r.id} room={r} active={r.id === current} />
      ))}
      {!collapsed && !project.rooms.length && (
        <button className="sb-new-in" onClick={startNew} title={`New ${modeLabel} session in ${project.folder}`}>
          <Icon name="plus" size={13} />
          <span>New {modeLabel} session</span>
        </button>
      )}
    </div>
  )
}

export function Sidebar() {
  const rooms = useApp((s) => s.rooms)
  const projects = useApp((s) => s.settings?.projects ?? EMPTY)
  const mode = useApp((s) => s.mode)
  const setMode = useApp((s) => s.setMode)
  const current = useApp((s) => s.currentRoomId)
  const currentFolder = useApp((s) => (s.currentRoomId ? s.roomData[s.currentRoomId]?.folder : undefined))
  const platform = useApp((s) => s.platform)
  const openNewSession = useApp((s) => s.openNewSession)
  const addProject = useApp((s) => s.addProject)
  const openSettings = useApp((s) => s.openSettings)
  const openRoom = useApp((s) => s.openRoom)
  const setSidebar = useApp((s) => s.setSidebar)
  const setSearchOpen = useApp((s) => s.setSearchOpen)
  const [collapsed, toggle] = useStoredList('iface.collapsedGroups')
  const groups = useMemo(() => projectGroups(rooms, projects, mode), [rooms, projects, mode])

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
        <button className="sb-nav-row" onClick={() => openNewSession(currentFolder ?? groups[0]?.folder, mode)}>
          <Icon name="plus" size={16} />
          <span>New session</span>
          <kbd>{shortcut(platform, 'N')}</kbd>
        </button>
        <button className="sb-nav-row" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd>{shortcut(platform, 'K')}</kbd>
        </button>
        <button className="sb-nav-row" onClick={() => void addProject()}>
          <Icon name="folderPlus" size={16} />
          <span>Add project</span>
          <kbd>{shortcut(platform, 'O')}</kbd>
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
        {groups.map((g) => (
          <ProjectSection key={g.folder} project={g} mode={mode} collapsed={collapsed.includes(g.folder)} onToggle={toggle} current={current} />
        ))}
        {!groups.length && (
          <div className="sb-empty">
            A project is a folder your agents work in. Its sessions are listed under it.
            <button className="sb-empty-start" onClick={() => void addProject()}>Add project</button>
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
