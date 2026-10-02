import { useEffect, useMemo, useRef, useState } from 'react'
import { createTwoFilesPatch } from 'diff'
import { editedPaths } from '@shared/changes'
import { parseUnifiedDiff } from '@shared/diff'
import type { GitFile, GitState, Message, Room } from '@shared/types'
import { basename, isBusy, joinPath, relative, str, timeOf } from '../lib/format'
import { act, useApp } from '../store'
import { DiffViewer } from './DiffViewer'
import { Icon } from './Icon'

interface RecordedEdit { diff: string; label: string; messageId: string; author: string; undone?: boolean }
interface RecordedFile extends GitFile { edits: RecordedEdit[] }

function recordedFiles(messages: Message[], room: Room): RecordedFile[] {
  const files = new Map<string, RecordedFile>()
  const add = (path: string, diff: string, message: Message, excerpt = false): void => {
    path = relative(path, room.members.find((m) => m.id === message.author)?.worktree?.path ?? room.folder)
    const parsed = parseUnifiedDiff(diff, path)
    const entry = files.get(path) ?? { path, status: 'recorded', added: 0, removed: 0, edits: [] }
    entry.added = (entry.added ?? 0) + parsed.reduce((n, f) => n + f.added, 0)
    entry.removed = (entry.removed ?? 0) + parsed.reduce((n, f) => n + f.removed, 0)
    entry.edits.push({ diff, label: `${message.authorName ?? message.author} · ${timeOf(message.createdAt)}${excerpt ? ' · recorded edit excerpt' : ' · turn changes'}`, messageId: message.id, author: message.author, undone: message.undone })
    files.set(path, entry)
  }
  for (const message of messages) {
    if (message.author === 'user') continue
    if (message.diff) {
      // Split at git file headers, preserving original patch text and exact line numbers.
      const patches = message.diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim())
      for (const patch of patches) {
        const file = parseUnifiedDiff(patch)[0]
        if (file) add(file.path, patch, message)
      }
      continue
    }
    for (const block of message.blocks) {
      if (block.kind !== 'tool' || block.status !== 'done') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      const paths = editedPaths(block)
      if (!paths.length) continue
      if (block.name === 'Edit files' && Array.isArray(input.changes)) {
        for (const change of input.changes) if (typeof change.path === 'string') add(change.path, typeof change.diff === 'string' ? change.diff : '', message)
      } else if (block.name === 'Write') {
        add(paths[0], createTwoFilesPatch(paths[0], paths[0], '', str(input.content)), message, true)
      } else if (block.name === 'Edit' || block.name === 'MultiEdit') {
        const edits = block.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input]
        for (const edit of edits) add(paths[0], createTwoFilesPatch(paths[0], paths[0], str(edit.old_string), str(edit.new_string)), message, true)
      } else add(paths[0], '', message, true)
    }
  }
  return [...files.values()]
}

export function ChangesPanel({ room }: { room: Room }) {
  const target = useApp((s) => s.changeTarget)
  const follow = useApp((s) => s.followChanges)
  const setFollow = useApp((s) => s.setFollowChanges)
  const setPreview = useApp((s) => s.setPreview)
  const statuses = useApp((s) => s.statuses[room.id])
  const busy = Object.values(statuses ?? {}).some((runtime) => isBusy(runtime.status))
  const [source, setSource] = useState<'working' | 'recorded'>('working')
  const [scope, setScope] = useState('')
  const [state, setState] = useState<GitState>()
  const [selected, setSelected] = useState('')
  const [diff, setDiff] = useState<string>()
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [turn, setTurn] = useState('')
  const [tick, setTick] = useState(0)
  const [revision, setRevision] = useState(0)
  const [mode, setMode] = useState<'unified' | 'split'>('unified')
  const fingerprint = useRef('')
  const refreshRef = useRef<() => void>(() => {})
  const previouslyPresent = useRef('')
  const member = room.members.find((m) => m.id === scope)
  const root = member?.worktree?.path ?? room.folder
  const rootVersion = useApp((s) => s.dirVersion[root] ?? 0)
  const recorded = source === 'recorded' || state?.isRepo === false
  const historyVersion = recorded ? room.messages.map((message) => `${message.id}:${message.undone}:${message.diff ?? ''}:${message.blocks.filter((block) => block.kind === 'tool' && block.status === 'done').map((block) => block.id).join(',')}`).join('|') : ''
  const records = useMemo(() => recorded ? recordedFiles(room.messages.filter((m) => !turn || m.id === turn), room) : [], [recorded, historyVersion, room.folder, room.members, turn]) // eslint-disable-line react-hooks/exhaustive-deps
  const allFiles: GitFile[] = recorded ? records : state?.files ?? []
  const visible = allFiles.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
  const current = allFiles.find((file) => file.path === selected)
  const completed = room.messages.filter((m) => m.author !== 'user' && m.status !== 'streaming').length

  useEffect(() => {
    setScope(''); setSelected(''); setState(undefined); setDiff(undefined); setTurn(''); fingerprint.current = ''
  }, [room.id])
  useEffect(() => {
    void window.iface.watchDir(root).catch(() => {})
    return () => { void window.iface.unwatchDir(root).catch(() => {}) }
  }, [root])
  useEffect(() => {
    let live = true, running = false, dirty = false
    const refresh = async (): Promise<void> => {
      if (running) { dirty = true; return }
      if (!live || document.hidden) return
      running = true
      try {
        const result = await window.iface.gitStatus(room.id, scope || undefined)
        if (!live) return
        const next = JSON.stringify(result)
        if (next !== fingerprint.current) { fingerprint.current = next; setState(result) }
        setError(result.error ?? '')
        setRevision((value) => value + 1)
      } catch (err) { if (live) setError(String(err)) }
      finally { running = false; if (dirty && live) { dirty = false; void refresh() } }
    }
    fingerprint.current = ''
    setState(undefined)
    refreshRef.current = () => { void refresh() }
    void refresh()
    // Poll only while this panel is mounted; covers shell edits and nested folders on Linux.
    const timer = setInterval(() => void refresh(), busy ? 1500 : 5000)
    const focus = (): void => { void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { live = false; refreshRef.current = () => {}; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [room.id, scope, busy])
  useEffect(() => { refreshRef.current() }, [tick, completed, rootVersion])
  useEffect(() => {
    if (!target) return
    const owner = room.members.find((m) => m.id === target.memberId)
    setScope(owner?.worktree ? owner.id : '')
    setSelected(relative(target.path, owner?.worktree?.path ?? room.folder))
    if (target.messageId) { setSource('recorded'); setTurn(target.messageId) }
    else { setSource('working'); setTurn('') }
  }, [target, room.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (allFiles.some((file) => file.path === selected)) previouslyPresent.current = selected
    else if ((!selected || previouslyPresent.current === selected) && allFiles.length) { setSelected(allFiles[0].path); previouslyPresent.current = '' }
  }, [selected, allFiles])
  useEffect(() => {
    if (recorded || !current) return
    let live = true
    window.iface.gitDiff(room.id, current.path, scope || undefined, current.oldPath)
      .then((text) => { if (live) { setDiff(text); setError('') } })
      .catch((err) => { if (live) { setDiff(undefined); setError(String(err)) } })
    return () => { live = false }
  }, [room.id, scope, current?.path, current?.oldPath, recorded, revision]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDiff(undefined) }, [selected, scope, source])

  return (
    <div className="changes-review">
      <div className="review-toolbar">
        <div className="scope-tabs">
          <button className={`chip ${!recorded ? 'on' : ''}`} onClick={() => { setSource('working'); setTurn(''); setSelected('') }} disabled={state?.isRepo === false}>Working tree</button>
          <button className={`chip ${recorded ? 'on' : ''}`} onClick={() => { setSource('recorded'); setSelected('') }}>This chat</button>
        </div>
        <label className="review-follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow edits</label>
        <button className="icon-btn" title="Refresh changes" onClick={() => setTick((value) => value + 1)}><Icon name="refresh" size={14} /></button>
      </div>
      {room.members.some((m) => m.worktree) && !recorded && <select className="review-select" value={scope} onChange={(e) => { setScope(e.target.value); setSelected(''); setState(undefined) }} aria-label="Changes folder"><option value="">Project folder</option>{room.members.filter((m) => m.worktree).map((m) => <option key={m.id} value={m.id}>{m.name}'s copy</option>)}</select>}
      {recorded && <select className="review-select" value={turn} onChange={(e) => { setTurn(e.target.value); setSelected('') }} aria-label="Recorded turn"><option value="">All recorded turns</option>{room.messages.filter((m) => m.author !== 'user' && (m.diff || m.blocks.some((block) => editedPaths(block).length))).map((m) => <option key={m.id} value={m.id}>{m.authorName ?? m.author} · {timeOf(m.createdAt)}{m.undone ? ' · undone' : ''}</option>)}</select>}
      <div className="review-summary"><span>{allFiles.length} changed file{allFiles.length === 1 ? '' : 's'}{!recorded && state?.branch ? ` · ${state.branch}` : ''}</span><span className="change-stat"><span className="add">+{allFiles.reduce((sum, file) => sum + (file.added ?? 0), 0)}</span> <span className="del">−{allFiles.reduce((sum, file) => sum + (file.removed ?? 0), 0)}</span></span></div>
      {error && <div className="review-error" role="alert">{error.replace(/^Error: /, '')}</div>}
      {recorded && <div className="panel-note">Recorded patches and edit excerpts. Shared-folder turn snapshots may include concurrent edits; undone changes are marked below.</div>}
      {(allFiles.length > 6 || filter) && <input className="review-filter" placeholder="Filter files…" aria-label="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="review-file-list" aria-label="Changed files">
        {visible.map((file) => <button key={file.path} className={`change-row ${file.path === selected ? 'on' : ''}`} title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`} onClick={() => { setSelected(file.path); setFollow(false) }}>
          <span className={`git-status st-${file.status}`}>{file.status === 'recorded' ? 'M' : file.status[0].toUpperCase()}</span>
          <span className="change-path">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}{file.path}</span>
          <span className="change-stat">{file.binary ? 'Binary' : <><span className="add">{file.added !== undefined ? `+${file.added}` : ''}</span> <span className="del">{file.removed !== undefined ? `−${file.removed}` : ''}</span></>}{file.staged ? <span className="review-staged">Staged</span> : null}</span>
        </button>)}
        {!visible.length && <div className="panel-empty">{!state && !recorded ? 'Reading changes…' : filter ? 'No matching files.' : recorded ? 'No file edits recorded in this selection.' : 'No uncommitted changes. Choose This chat to review recorded edits.'}</div>}
      </div>
      {current && <>
        <div className="review-editor-toolbar">
          <span title={current.path}>{basename(current.path)}</span>
          <div className="review-view-mode" aria-label="Diff layout"><button className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')}>Unified</button><button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>Before / after</button></div>
          <button className="icon-btn" title="Open current file" disabled={current.status === 'deleted'} onClick={() => {
            const author = recorded ? records.find((file) => file.path === current.path)?.edits.at(-1)?.author : undefined
            const fileRoot = author ? room.members.find((m) => m.id === author)?.worktree?.path ?? room.folder : root
            setPreview({ path: joinPath(fileRoot, current.path) })
          }}><Icon name="file" size={13} /></button>
        </div>
        <div className="review-scroll">
          {recorded ? records.find((file) => file.path === current.path)?.edits.map((edit, index) => <div key={`${edit.messageId}-${index}`}><div className="review-record-label">{edit.label}{edit.undone ? ' · Undone' : ''}</div>{edit.diff ? <DiffViewer diff={edit.diff} path={current.path} mode={mode} /> : <div className="panel-note">File activity recorded without a text patch.</div>}</div>)
            : diff === undefined ? <div className="panel-empty">Loading diff…</div> : diff ? <DiffViewer key={current.path} diff={diff} path={current.path} mode={mode} /> : <div className="panel-note">No text changes; this may be a rename, mode change, or binary file.</div>}
        </div>
      </>}
      {member?.worktree && !recorded && <div className="worktree-actions">
        <button className="btn tiny" disabled={busy} onClick={() => void act(() => window.iface.mergeWorktree(room.id, member.id), (result) => result).then(() => setTick((value) => value + 1))}><Icon name="merge" size={12} /> Merge into project</button>
        <button className="btn tiny" disabled={busy} onClick={() => { if (confirm(`Discard all changes in ${member.name}'s separate copy?`)) void act(() => window.iface.discardWorktree(room.id, member.id), (result) => result).then(() => setTick((value) => value + 1)) }}>Discard</button>
      </div>}
    </div>
  )
}
