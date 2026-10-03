import { useEffect, useState, type CSSProperties } from 'react'
import type { FileEntry, McpServer, Room } from '@shared/types'
import { joinPath } from '../lib/format'
import { act, useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { Markdown } from './Markdown'
import { ChangesPanel } from './ChangesPanel'
import { FilePreview } from './FilePreview'

function useDir(path: string): FileEntry[] | undefined {
  const version = useApp((s) => s.dirVersion[path] ?? 0)
  const [entries, setEntries] = useState<FileEntry[]>()
  useEffect(() => {
    let live = true
    window.iface
      .listDir(path)
      .then((e) => live && setEntries(e))
      .catch(() => live && setEntries([]))
    return () => {
      live = false
    }
  }, [path, version])
  useEffect(() => {
    void window.iface.watchDir(path)
    return () => void window.iface.unwatchDir(path)
  }, [path])
  return entries
}

function DirChildren({ path, depth, expanded, toggle }: { path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void }) {
  const entries = useDir(path)
  const setPreview = useApp((s) => s.setPreview)
  if (!entries) return <div className="tree-loading" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</div>
  if (!entries.length && depth === 0) return <div className="panel-empty">This folder is empty.</div>
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <button className="tree-row" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => (e.isDir ? toggle(e.path) : setPreview({ path: e.path }))} title={e.path}>
            {e.isDir ? <Icon name={expanded.has(e.path) ? 'chevronDown' : 'chevronRight'} size={12} /> : <span className="tree-gap" />}
            <Icon name={e.isDir ? (expanded.has(e.path) ? 'folderOpen' : 'folder') : 'file'} size={14} className={e.isDir ? 'tree-dir' : 'tree-file'} />
            <span className="tree-name">{e.name}</span>
          </button>
          {e.isDir && expanded.has(e.path) && <DirChildren path={e.path} depth={depth + 1} expanded={expanded} toggle={toggle} />}
        </div>
      ))}
    </>
  )
}

function FileTree({ room }: { room: Room }) {
  const roots = [{ label: 'Project', path: room.folder }, ...room.members.filter((m) => m.worktree).map((m) => ({ label: `${m.name}'s copy`, path: m.worktree!.path }))]
  const [root, setRoot] = useState(room.folder)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    setExpanded(new Set())
    setRoot(room.folder)
  }, [room.id, room.folder])
  const toggle = (p: string): void => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }
  return (
    <div className="tree">
      {roots.length > 1 && (
        <div className="scope-tabs">
          {roots.map((r) => (
            <button key={r.path} className={`chip ${root === r.path ? 'on' : ''}`} onClick={() => setRoot(r.path)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
      <DirChildren path={root} depth={0} expanded={expanded} toggle={toggle} />
    </div>
  )
}

function Tasks({ room }: { room: Room }) {
  const dir = joinPath(room.folder, `.collab/${room.id}`)
  const file = `${dir}/tasks.md`
  const version = useApp((s) => s.dirVersion[dir] ?? 0)
  const [content, setContent] = useState<string>()
  useEffect(() => {
    void window.iface.watchDir(dir)
    return () => void window.iface.unwatchDir(dir)
  }, [dir])
  useEffect(() => {
    window.iface
      .readFile(file)
      .then((f) => setContent(f.content))
      .catch(() => setContent(''))
  }, [file, version])
  const body = (content ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/^# Task board\s*/i, '').trim()
  return (
    <div className="tasks">
      <div className="panel-sub">
        <span>Shared task board</span>
        <button className="icon-btn" title="Open tasks.md" onClick={() => void window.iface.openPath(file)}>
          <Icon name="external" size={13} />
        </button>
      </div>
      {body ? (
        <div className="tasks-md">
          <Markdown text={body} roomId={room.id} fromFile={file} />
        </div>
      ) : (
        <div className="panel-empty">No tasks yet. Ask the agents to plan, for example: "@both split this into tasks on the board, then start."</div>
      )}
    </div>
  )
}

function Mcp({ room }: { room: Room }) {
  const [memberId, setMemberId] = useState(room.members[0]?.id)
  const [servers, setServers] = useState<McpServer[]>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  const member = room.members.find((m) => m.id === memberId) ?? room.members[0]

  useEffect(() => {
    if (!member) return
    let live = true
    setServers(undefined)
    setError(undefined)
    window.iface
      .mcpList(room.id, member.id)
      .then((s) => live && setServers(s))
      .catch((err: Error) => live && setError(err.message.replace(/^Error invoking remote method 'api': (Error: )?/, '')))
    return () => {
      live = false
    }
  }, [room.id, member?.id, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!member) return null
  return (
    <div className="mcp">
      {room.members.length > 1 && (
        <div className="scope-tabs">
          {room.members.map((m) => (
            <button key={m.id} className={`chip ${m.id === member.id ? 'on' : ''}`} onClick={() => setMemberId(m.id)}>
              <AgentMark provider={m.provider} color={m.color} size={12} /> {m.name}
            </button>
          ))}
        </div>
      )}
      <div className="panel-sub">
        <span>MCP servers for {member.name}</span>
        <button className="icon-btn" title="Refresh" onClick={() => setTick((t) => t + 1)}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {error ? (
        <div className="panel-empty">{error}</div>
      ) : !servers ? (
        <div className="panel-empty">Asking {member.provider === 'claude' ? 'Claude Code' : 'Codex'}…</div>
      ) : !servers.length ? (
        <div className="panel-empty">No MCP servers configured for this account.</div>
      ) : (
        servers.map((s) => {
          const ok = s.status === 'connected'
          const off = s.status === 'disabled'
          return (
            <div key={s.name} className="mcp-row">
              <span className={`status-dot ${ok ? 'ok' : off ? 'off' : s.status === 'failed' || s.status === 'authenticationRequired' ? 'bad' : 'wait'}`} />
              <span className="mcp-main">
                <span className="mcp-name">{s.name}</span>
                <span className="mcp-detail">
                  {s.status}
                  {s.tools != null ? ` · ${s.tools} tools` : ''}
                  {s.scope ? ` · ${s.scope}` : ''}
                  {s.error ? ` · ${s.error}` : ''}
                </span>
              </span>
              {member.provider === 'claude' && (
                <button
                  className="btn tiny"
                  onClick={() => void act(() => window.iface.mcpToggle(room.id, member.id, s.name, off)).then(() => setTick((t) => t + 1))}
                >
                  {off ? 'Turn on' : 'Turn off'}
                </button>
              )}
              <button className="icon-btn tiny" title="Reconnect" onClick={() => void act(() => window.iface.mcpReconnect(room.id, member.id, s.name)).then(() => setTick((t) => t + 1))}>
                <Icon name="refresh" size={12} />
              </button>
            </div>
          )
        })
      )}
      <div className="panel-note">
        To add servers, use the terminal: <code>{member.provider === 'claude' ? 'claude mcp add …' : 'codex mcp add …'}</code>. The terminal opens as this
        account when you pick it there.
      </div>
    </div>
  )
}

export function RightPanel({ room }: { room: Room }) {
  const panel = useApp((s) => s.panel)
  const preview = useApp((s) => s.preview)
  const setPanel = useApp((s) => s.setPanel)
  const historyCount = useApp((s) => s.previewHistory.length)
  const historyIndex = useApp((s) => s.previewIndex)
  const navigate = useApp((s) => s.navigatePreview)
  const width = useApp((s) => s.panelWidth)
  const setWidth = useApp((s) => s.setPanelWidth)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const setFollow = useApp((s) => s.setFollowChanges)
  if (!panel && !preview) return null
  const title = panel === 'tasks' ? 'Task board' : panel === 'changes' ? 'Changes' : panel === 'mcp' ? 'MCP servers' : 'Files'
  return (
    <aside className="right-panel" style={{ '--panel-width': `${width}px`, '--sidebar-width': sidebarOpen ? '264px' : '0px' } as CSSProperties}>
      <div className="panel-resize no-drag" role="separator" aria-label="Resize side panel" aria-orientation="vertical" tabIndex={0}
        onKeyDown={(event) => {
          const visible = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width
          if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(visible + 40) }
          if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(visible - 40) }
        }}
        onPointerDown={(event) => {
          event.preventDefault()
          const origin = event.clientX, handle = event.currentTarget, initial = handle.parentElement?.getBoundingClientRect().width ?? width
          handle.setPointerCapture(event.pointerId)
          const move = (next: PointerEvent): void => setWidth(Math.min(window.innerWidth - (sidebarOpen ? 264 : 0) - 360, initial + origin - next.clientX))
          const end = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
          handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end)
        }} />
      <div className="panel-head drag">
        <div className="panel-tabs no-drag" aria-label="Side panel views">
          {historyCount > 0 && <button className={`panel-tab ${preview ? 'active' : ''}`} onClick={() => navigate(historyIndex)}>Preview</button>}
          <button className={`panel-tab ${!preview && panel === 'files' ? 'active' : ''}`} onClick={() => setPanel('files')}>Files</button>
          <button className={`panel-tab ${!preview && panel === 'changes' ? 'active' : ''}`} onClick={() => setPanel('changes')}>Changes</button>
          {(panel === 'tasks' || panel === 'mcp') && <button className={`panel-tab ${!preview ? 'active' : ''}`} onClick={() => setPanel(panel)}>{title}</button>}
        </div>
        <button className="icon-btn no-drag" onClick={() => { setPanel(null); if (panel === 'changes') setFollow(false) }} title="Close panel">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className={`panel-body ${panel === 'changes' && !preview ? 'panel-review' : ''}`}>
        {preview ? (
          <FilePreview key={`${room.id}:${preview.path}:${preview.revision ?? 0}`} room={room} target={preview} />
        ) : panel === 'tasks' ? (
          <Tasks room={room} />
        ) : panel === 'changes' ? (
          <ChangesPanel key={room.id} room={room} />
        ) : panel === 'mcp' ? (
          <Mcp room={room} />
        ) : (
          <FileTree room={room} />
        )}
      </div>
    </aside>
  )
}
