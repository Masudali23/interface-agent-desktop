import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import hljs from 'highlight.js/lib/common'
import type { FileContent, FileEntry, McpServer, Room } from '@shared/types'
import { basename, joinPath, languageOf, relative } from '../lib/format'
import { act, useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { Markdown } from './Markdown'
import { ChangesPanel } from './ChangesPanel'

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

function Preview({ room, path }: { room: Room; path: string }) {
  const setPreview = useApp((s) => s.setPreview)
  const parent = path.replace(/[\\/][^\\/]+$/, '')
  const version = useApp((s) => s.dirVersion[parent] ?? 0)
  const [file, setFile] = useState<FileContent | { error: string }>()
  const [source, setSource] = useState(false)
  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path)
  const isMd = /\.(md|markdown)$/i.test(path)

  useEffect(() => {
    void window.iface.watchDir(parent)
    return () => void window.iface.unwatchDir(parent)
  }, [parent])

  useEffect(() => {
    setFile(undefined)
    if (isImage) return
    let live = true
    window.iface
      .readFile(path)
      .then((f) => live && setFile(f))
      .catch((err: Error) => live && setFile({ error: err.message }))
    return () => {
      live = false
    }
  }, [path, version, isImage])

  const html = useMemo(() => {
    if (!file || 'error' in file || file.binary || file.content.length > 300000) return undefined
    const lang = languageOf(path)
    try {
      return lang && hljs.getLanguage(lang) ? hljs.highlight(file.content, { language: lang }).value : undefined
    } catch {
      return undefined
    }
  }, [file, path])

  return (
    <div className="preview">
      <div className="preview-head">
        <button className="icon-btn" onClick={() => setPreview(undefined)} title="Back">
          <Icon name="back" size={14} />
        </button>
        <span className="preview-path" title={path}>
          {relative(path, room.folder)}
        </span>
        {isMd && (
          <button className="btn tiny" onClick={() => setSource(!source)}>
            {source ? 'Rendered' : 'Source'}
          </button>
        )}
        <button className="icon-btn" title="Open in default app" onClick={() => void window.iface.openPath(path)}>
          <Icon name="external" size={14} />
        </button>
      </div>
      <div className="preview-body">
        {isImage ? (
          <img className="preview-img" src={`iface://file/${encodeURIComponent(path)}?v=${version}`} alt={basename(path)} />
        ) : !file ? (
          <div className="panel-empty">Loading…</div>
        ) : 'error' in file ? (
          <div className="panel-empty">{file.error}</div>
        ) : file.binary ? (
          <div className="panel-empty">Binary file ({Math.round(file.size / 1024)} KB). Open it in its own app.</div>
        ) : isMd && !source ? (
          <div className="preview-md">
            <Markdown text={file.content} />
          </div>
        ) : (
          <pre className="preview-code">{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{file.content}</code>}</pre>
        )}
        {file && !('error' in file) && file.truncated && <div className="panel-note">Showing the first 512 KB.</div>}
      </div>
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
          <Markdown text={body} />
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
  const width = useApp((s) => s.panelWidth)
  const setWidth = useApp((s) => s.setPanelWidth)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const setFollow = useApp((s) => s.setFollowChanges)
  if (!panel && !preview) return null
  const title = preview ? 'Preview' : panel === 'tasks' ? 'Task board' : panel === 'changes' ? 'Changes' : panel === 'mcp' ? 'MCP servers' : 'Files'
  return (
    <aside className="right-panel" style={{ '--panel-width': `${width}px`, '--sidebar-width': sidebarOpen ? '264px' : '0px' } as CSSProperties}>
      <div className="panel-resize no-drag" role="separator" aria-label="Resize review panel" aria-orientation="vertical" tabIndex={0}
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
        <span className="panel-title">{title}</span>
        <button className="icon-btn no-drag" onClick={() => { setPanel(null); if (panel === 'changes') setFollow(false) }} title="Close panel">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className={`panel-body ${panel === 'changes' && !preview ? 'panel-review' : ''}`}>
        {preview ? (
          <Preview room={room} path={preview.path} />
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
