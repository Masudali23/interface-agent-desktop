import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { parseMentions } from '@shared/mentions'
import { activeMemberIds, type Room, type SlashCommand } from '@shared/types'
import { act, useApp } from '../store'
import { AgentMark, Icon } from './Icon'
import { ContextRing, ModelMenu, ModeMenu, Popover } from './MemberControls'
import { ComposerAttachments } from './ComposerAttachments'
import { QueuedTray } from './QueuedTray'
import { composerDraftKey, composerRecipients } from '../lib/agentPanes'
import { composerDrafts as drafts } from '../lib/composerDrafts'
import { activeToken, ATTACHMENT_ONLY_TEXT, busyRecipients, composerKeyAction, composerPlaceholder, insertTrigger, isMac, listNames, outgoingText, queuedMessages, restoreQueued } from '../lib/composer'

interface ComposerProps { room: Room; busy: boolean; memberId?: string }

interface Suggestion {
  key: string
  insert: string
  label: string
  detail?: string
  kind: 'member' | 'file' | 'command'
  color?: string
  provider?: 'claude' | 'codex'
}

export function Composer(props: ComposerProps) {
  return <ComposerInput key={composerDraftKey(props.room.id, props.memberId)} {...props} />
}

// Send, stop and the hints follow this composer's recipients, not the whole room: with
// Claude mid-turn and only GPT addressed, the box is an ordinary idle composer for GPT.
function ComposerInput({ room, memberId }: ComposerProps) {
  const team = room.members.length > 1
  const member = room.members.find((m) => m.id === memberId)
  const draftKey = composerDraftKey(room.id, memberId)
  const meta = useApp((s) => s.meta)
  const platform = useApp((s) => s.platform)
  const statuses = useApp((s) => s.statuses[room.id])
  const setError = useApp((s) => s.setError)

  const { text, attachments, saving } = useSyncExternalStore(
    useCallback((listener) => drafts.subscribe(draftKey, listener), [draftKey]),
    useCallback(() => drafts.get(draftKey), [draftKey])
  )
  const setText = (next: string): void => drafts.setText(draftKey, next)
  const [caret, setCaret] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const memberIds = room.members.map((m) => m.id)
  const targets = activeMemberIds(room)
  const mentioned = team && !memberId ? parseMentions(text, room.members) : undefined
  const effective = composerRecipients(room, text, memberId)
  const busyIds = busyRecipients(effective, statuses)
  const recipientBusy = busyIds.length > 0
  const hasContent = !!text.trim() || attachments.length > 0
  const queued = useMemo(() => queuedMessages(room.messages, memberId), [room.messages, memberId])

  useEffect(() => {
    if (!memberId) ref.current?.focus()
  }, [memberId])

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, memberId ? 100 : 320)}px`
    }
  }, [text, memberId])

  const token = menuClosed ? undefined : activeToken(text, caret)

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
    const people: Suggestion[] = team && !memberId
      ? [
          ...room.members
            .filter((m) => m.handle.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q))
            .map((m) => ({ key: `m-${m.id}`, insert: `@${m.handle} `, label: `@${m.handle}`, detail: m.name, kind: 'member' as const, color: m.color, provider: m.provider })),
          ...('both'.startsWith(q) ? [{ key: 'm-both', insert: '@both ', label: '@both', detail: 'Everyone', kind: 'member' as const }] : [])
        ]
      : []
    const fileItems = files.slice(0, 8).map((f) => ({ key: `f-${f}`, insert: `@${f} `, label: f, kind: 'file' as const }))
    return [...people, ...fileItems].slice(0, 12)
  }, [token, files, meta, room.members, team, memberId, effective.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [menuIndex, suggestions.length])

  const placeCaret = (pos: number): void => {
    setCaret(pos)
    setMenuIndex(0)
    setMenuClosed(false)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const choose = (s: Suggestion): void => {
    if (!token) return
    setText(text.slice(0, token.start) + s.insert + text.slice(caret))
    placeCaret(token.start + s.insert.length)
  }

  const startTrigger = (trigger: '@' | '/'): void => {
    const next = insertTrigger(text, ref.current?.selectionStart ?? text.length, trigger)
    setText(next.text)
    placeCaret(next.caret)
  }

  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const picked = Array.from(list)
    drafts.startSaving(draftKey, picked.length)
    for (const file of picked) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const att = await window.iface.saveAttachment(room.id, file.name || `pasted-${Date.now()}.png`, bytes)
        drafts.addAttachment(draftKey, att)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        drafts.finishSaving(draftKey)
      }
    }
  }

  // A send that fails puts the message back, so nothing typed is lost. In the room composer
  // the mentions in front of a slash command pick its recipients and are not sent with it.
  const send = async (queue: boolean): Promise<void> => {
    if (!effective.length) return
    const draft = drafts.take(draftKey)
    if (!draft) return
    const body = (memberId ? draft.text : outgoingText(draft.text, room.members)).trim()
    let sent = false
    await act(async () => {
      await window.iface.send(room.id, { text: body || ATTACHMENT_ONLY_TEXT, to: effective, attachments: draft.attachments, ...(queue ? { queue: true } : {}) })
      sent = true
    })
    if (!sent) drafts.restore(draftKey, [draft])
  }

  // Stops only the agents this composer addresses; their queued messages come back into
  // the composers that send them to the same agents again.
  const stop = async (): Promise<void> => {
    const restored = await Promise.all(busyIds.map((id) => act(() => window.iface.stop(room.id, id))))
    restoreQueued(room, restored.flatMap((items) => items ?? []), memberId)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((i) => (i + d + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault()
        choose(suggestions[menuIndex] ?? suggestions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuClosed(true)
        return
      }
    }
    const action = composerKeyAction(e, platform, recipientBusy)
    if (!action) return
    e.preventDefault()
    if (action === 'stop') void stop()
    else void send(action === 'queue' && recipientBusy)
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

  // Clicks on the box's empty space go to the text, as in a single text field.
  const focusText = (e: MouseEvent<HTMLDivElement>): void => {
    if (!(e.target as HTMLElement).closest('button, input, textarea, .popover, [role="listbox"]')) {
      e.preventDefault()
      ref.current?.focus()
    }
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
  const placeholder = composerPlaceholder({ platform, busy: recipientBusy, team, names, memberName: member?.name })
  const queueKeys = isMac(platform) ? '⌘↵' : 'Ctrl+Enter'
  const sendTitle = saving > 0
    ? 'Waiting for attachments to finish saving'
    : recipientBusy ? `Send now (${isMac(platform) ? '↵' : 'Enter'}). ${queueKeys} queues it for after the current turn` : `Send (${isMac(platform) ? '↵' : 'Enter'})`
  const showMenu = suggestions.length > 0

  return (
    <div className={`cmp ${memberId ? 'cmp-scoped' : ''}`}>
      <QueuedTray room={room} queued={queued} memberId={memberId} />
      <div
        className={`cmp-box ${dragging ? 'dragging' : ''}`}
        onMouseDown={focusText}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('Files')) setDragging(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging && e.dataTransfer.types.includes('Files')) setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {showMenu && (
          <div className="cmp-suggest" role="listbox" id={listId} ref={menuRef} aria-label={token?.token[0] === '/' ? 'Commands' : 'Mentions'}>
            <div className="cmp-suggest-title">{token?.token[0] === '/' ? 'Commands' : team && !memberId ? 'Agents and files' : 'Files'}</div>
            {suggestions.map((s, i) => (
              <button
                key={s.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === menuIndex}
                className={`cmp-suggest-item ${i === menuIndex ? 'on' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(s)
                }}
              >
                {s.kind === 'member' && s.provider ? (
                  <AgentMark provider={s.provider} color={s.color} size={16} />
                ) : (
                  <Icon name={s.kind === 'file' ? 'file' : s.kind === 'member' ? 'users' : 'code'} size={14} />
                )}
                <span className={`cmp-suggest-label ${s.kind === 'file' ? 'file' : ''}`}>{s.label}</span>
                {s.detail && <span className="cmp-suggest-detail">{s.detail}</span>}
              </button>
            ))}
          </div>
        )}
        {member && <div className="cmp-pane-label">To @{member.handle}<span>Visible to the room</span></div>}
        {team && !memberId && (
          <div className="cmp-targets">
            <span className="cmp-targets-label">{room.dispatch === 'lead' && !mentioned ? 'Team' : 'To'}</span>
            {room.members.map((m) => {
              const on = (mentioned ? effective : targets).includes(m.id)
              const only = !mentioned && on && targets.length === 1
              return (
                <button
                  key={m.id}
                  className={`cmp-target ${on ? 'on' : ''} ${mentioned ? 'locked' : ''}`}
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
                  <span className="cmp-target-check" style={on ? { background: m.color, borderColor: m.color } : undefined}>
                    {on && <Icon name="check" size={10} />}
                  </span>
                  <AgentMark provider={m.provider} color={m.color} size={14} />
                  {m.name}
                </button>
              )
            })}
            {!mentioned && targets.length < memberIds.length && (
              <button className="cmp-target cmp-target-all" onClick={() => setActive(memberIds)} title="Tick every agent">
                All
              </button>
            )}
          </div>
        )}
        {team && !memberId && room.dispatch === 'lead' && !mentioned && <div className="cmp-hint">Starts with {names.join(', ')}. Ticked agents are available for delegation.</div>}
        <div className="cmp-row">
          <Popover
            className="cmp-plus-anchor"
            portal
            button={(open, toggle) => (
              <button className={`cmp-round-btn ${open ? 'on' : ''}`} onClick={toggle} title="Add files, mentions and commands" aria-label="Add" aria-expanded={open}>
                <Icon name="plus" size={memberId ? 15 : 17} />
              </button>
            )}
          >
            {(close) => (
              <div className="model-menu cmp-plus-menu">
                <button className="menu-item row" onClick={() => { close(); fileRef.current?.click() }}>
                  <Icon name="paperclip" size={14} />
                  <span className="mi-label">Add files or photos</span>
                </button>
                <button className="menu-item row" onClick={() => { close(); startTrigger('@') }}>
                  <span className="cmp-glyph" aria-hidden="true">@</span>
                  <span className="mi-label">{team && !memberId ? 'Mention an agent or file' : 'Mention a file'}</span>
                </button>
                <button className="menu-item row" onClick={() => { close(); startTrigger('/') }}>
                  <span className="cmp-glyph" aria-hidden="true">/</span>
                  <span className="mi-label">Use a command</span>
                </button>
              </div>
            )}
          </Popover>
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
          <div className="cmp-main">
            <ComposerAttachments roomId={room.id} attachments={attachments} saving={saving} onRemove={(path) => drafts.removeAttachment(draftKey, path)} />
            <textarea
              ref={ref}
              value={text}
              rows={1}
              aria-label={member ? `Message ${member.name}` : 'Message the room'}
              aria-autocomplete="list"
              aria-controls={showMenu ? listId : undefined}
              aria-activedescendant={showMenu ? `${listId}-${menuIndex}` : undefined}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                setCaret(e.target.selectionStart)
                setMenuIndex(0)
                setMenuClosed(false)
              }}
              onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </div>
          <div className="cmp-actions">
            {recipientBusy && (
              <button className="cmp-round-btn cmp-stop" onClick={() => void stop()} title={`Stop ${listNames(room.members.filter((m) => busyIds.includes(m.id)).map((m) => m.name))} (Esc)`} aria-label="Stop">
                <span className="cmp-stop-square" />
              </button>
            )}
            {(!recipientBusy || hasContent) && (
              <button className="cmp-send" disabled={saving > 0 || !hasContent || !effective.length} onClick={() => void send(false)} title={sendTitle} aria-label="Send">
                <Icon name="send" size={memberId ? 14 : 16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {!memberId && <ComposerControls room={room} />}
    </div>
  )
}

/** Settings under the box, like Claude desktop: permission mode on the left, model and
 *  context on the right. Team rooms get one compact group per agent. */
function ComposerControls({ room }: { room: Room }) {
  if (room.members.length > 1) {
    return (
      <div className="cmp-controls cmp-controls-team">
        {room.members.map((m) => (
          <span key={m.id} className="cmp-member-group">
            <ModelMenu room={room} member={m} compact portal />
            <ModeMenu room={room} member={m} portal />
            <ContextRing room={room} member={m} />
          </span>
        ))}
      </div>
    )
  }
  const member = room.members[0]
  if (!member) return null
  return (
    <div className="cmp-controls">
      <ModeMenu room={room} member={member} portal />
      <span className="cmp-spacer" />
      <ModelMenu room={room} member={member} align="right" portal />
      <ContextRing room={room} member={member} />
    </div>
  )
}
