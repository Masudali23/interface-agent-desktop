import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { parseMentions } from '@shared/mentions'
import { activeMemberIds, defaultRecipients, type Attachment, type Room, type SlashCommand } from '@shared/types'
import { act, useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { ContextRing, ModelMenu, ModeMenu } from './MemberControls'

const drafts = new Map<string, string>()

interface Suggestion {
  key: string
  insert: string
  label: string
  detail?: string
  kind: 'member' | 'file' | 'command'
  color?: string
  provider?: 'claude' | 'codex'
}

/** The "@word" or "/word" being typed right before the cursor. */
function activeToken(text: string, caret: number): { start: number; token: string } | undefined {
  const before = text.slice(0, caret)
  const m = /(^|\s)([@/][^\s]*)$/.exec(before)
  if (!m) return undefined
  const start = before.length - m[2].length
  if (m[2][0] === '/' && start !== 0) return undefined
  return { start, token: m[2] }
}

export function Composer({ room, busy }: { room: Room; busy: boolean }) {
  const team = room.members.length > 1
  const meta = useApp((s) => s.meta)
  const setError = useApp((s) => s.setError)

  const [text, setText] = useState(drafts.get(room.id) ?? '')
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const memberIds = room.members.map((m) => m.id)
  const targets = activeMemberIds(room)
  const mentioned = team ? parseMentions(text, room.members) : undefined
  const effective = mentioned ?? defaultRecipients(room)

  useEffect(() => {
    setText(drafts.get(room.id) ?? '')
    setAttachments([])
    ref.current?.focus()
  }, [room.id])

  useEffect(() => {
    drafts.set(room.id, text)
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 320)}px`
    }
  }, [text, room.id])

  const token = activeToken(text, caret)

  useEffect(() => {
    if (!token || token.token[0] !== '@') return
    const q = token.token.slice(1)
    const t = setTimeout(() => {
      window.iface
        .searchFiles(room.id, q)
        .then(setFiles)
        .catch(() => setFiles([]))
    }, 120)
    return () => clearTimeout(t)
  }, [token?.token, room.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return []
    const q = token.token.slice(1).toLowerCase()
    if (token.token[0] === '/') {
      const seen = new Set<string>()
      const out: Suggestion[] = []
      for (const m of room.members.filter((x) => effective.includes(x.id))) {
        const cmds: SlashCommand[] = meta[m.accountId]?.commands ?? []
        for (const c of cmds) {
          if (seen.has(c.name) || !c.name.toLowerCase().startsWith(q)) continue
          seen.add(c.name)
          out.push({ key: `c-${c.name}`, insert: `/${c.name} `, label: `/${c.name}`, detail: c.argumentHint || c.description, kind: 'command', provider: m.provider })
        }
      }
      return out.slice(0, 10)
    }
    const people: Suggestion[] = team
      ? [
          ...room.members
            .filter((m) => m.handle.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q))
            .map((m) => ({ key: `m-${m.id}`, insert: `@${m.handle} `, label: `@${m.handle}`, detail: m.name, kind: 'member' as const, color: m.color, provider: m.provider })),
          ...('both'.startsWith(q) ? [{ key: 'm-both', insert: '@both ', label: '@both', detail: 'Everyone', kind: 'member' as const }] : [])
        ]
      : []
    const fileItems = files.slice(0, 8).map((f) => ({ key: `f-${f}`, insert: `@${f} `, label: f, kind: 'file' as const }))
    return [...people, ...fileItems].slice(0, 12)
  }, [token, files, meta, room.members, team, effective.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (s: Suggestion): void => {
    if (!token) return
    const next = text.slice(0, token.start) + s.insert + text.slice(caret)
    setText(next)
    const pos = token.start + s.insert.length
    setCaret(pos)
    setMenuIndex(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const addFiles = async (list: FileList | File[]): Promise<void> => {
    for (const file of Array.from(list)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const att = await window.iface.saveAttachment(room.id, file.name || `pasted-${Date.now()}.png`, bytes)
        setAttachments((cur) => [...cur, att])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t && !attachments.length) return
    setText('')
    setAttachments([])
    drafts.delete(room.id)
    await act(() => window.iface.send(room.id, { text: t || '(see attachment)', to: effective, attachments }))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((i) => (i + d + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        choose(suggestions[menuIndex] ?? suggestions[0])
        return
      }
      if (e.key === 'Escape') {
        setCaret(-1)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && busy) {
      void window.iface.stop(room.id)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      void addFiles(e.clipboardData.files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
  }

  // The ticks are saved with the session: unticked agents get no messages and no
  // automatic handoffs until they are ticked again (an @mention still reaches them).
  const setActive = (next: string[]): void => {
    if (next.length) void act(() => window.iface.updateRoom(room.id, { active: next }))
  }
  const toggleTarget = (id: string): void => {
    if (targets.includes(id)) {
      if (targets.length > 1) setActive(targets.filter((x) => x !== id))
    } else setActive(memberIds.filter((x) => x === id || targets.includes(x)))
  }

  const names = room.members.filter((m) => effective.includes(m.id)).map((m) => m.name)

  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {suggestions.length > 0 && (
        <div className="slash-menu">
          {suggestions.map((s, i) => (
            <button
              key={s.key}
              className={i === menuIndex ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(s)
              }}
            >
              {s.kind === 'member' && s.provider ? (
                <AgentMark provider={s.provider} color={s.color} size={14} />
              ) : (
                <Icon name={s.kind === 'file' ? 'file' : 'code'} size={13} />
              )}
              <span className="sm-label">{s.label}</span>
              {s.detail && <span className="sm-detail">{s.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        {team && (
          <div className="targets">
            <span className="targets-label">{room.dispatch === 'lead' && !mentioned ? 'Team' : 'To'}</span>
            {room.members.map((m) => {
              const on = (mentioned ? effective : targets).includes(m.id)
              const only = !mentioned && on && targets.length === 1
              return (
                <button
                  key={m.id}
                  className={`target ${on ? 'on' : ''} ${mentioned ? 'locked' : ''}`}
                  style={on ? { borderColor: m.color, background: `${m.color}1f` } : undefined}
                  onClick={() => !mentioned && toggleTarget(m.id)}
                  aria-pressed={on}
                  title={
                    mentioned
                      ? 'Set by the @mentions in your message'
                      : only
                        ? `${m.name} is the only agent ticked`
                        : on
                          ? `Untick: ${m.name} sits this out`
                          : `Tick: bring ${m.name} back in`
                  }
                >
                  <span className="target-check" style={on ? { background: m.color, borderColor: m.color } : undefined}>
                    {on && <Icon name="check" size={10} />}
                  </span>
                  <AgentMark provider={m.provider} color={m.color} size={14} />
                  {m.name}
                </button>
              )
            })}
            {!mentioned && targets.length < memberIds.length && (
              <button className="target target-all" onClick={() => setActive(memberIds)} title="Tick every agent">
                All
              </button>
            )}
          </div>
        )}
        {team && room.dispatch === 'lead' && !mentioned && <div className="dispatch-hint">Starts with {names.join(', ')}. Ticked agents are available for delegation.</div>}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="file-chip">
                <Icon name={a.mime.startsWith('image/') ? 'image' : 'file'} size={12} />
                {a.name}
                <button onClick={() => setAttachments((cur) => cur.filter((x) => x.path !== a.path))} title="Remove">
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={team ? `Message ${names.join(', ')}…  (@ to mention an agent or file, / for commands)` : `Message ${names[0] ?? ''}…  (@ for files, / for commands)`}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setMenuIndex(0)
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <div className="composer-members">{room.members.map((m) => (
            <span key={m.id} className="member-controls">
              <ModelMenu room={room} member={m} compact={team} />
              <ModeMenu room={room} member={m} />
              {!team && <ContextRing room={room} member={m} />}
            </span>
          ))}</div>
          <span className="foot-spacer" />
          {busy && (
            <button className="btn stop" onClick={() => void window.iface.stop(room.id)} title="Stop (Esc)">
              <Icon name="stop" size={12} /> Stop
            </button>
          )}
          <button className="send" disabled={!text.trim() && !attachments.length} onClick={() => void send()} title="Send (Enter)">
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
