import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { matchSessions, paletteKey } from '../lib/chrome'
import { ago, basename } from '../lib/format'
import { useApp } from '../store'
import { AgentMark, Icon } from './Icon'

const MODE_LABEL = { claude: 'Claude Code', codex: 'Codex', team: 'Team' } as const

type Item = { key: string; open: () => void }

/** ⌘K search: sessions by title or folder, and every message in every session. */
export function SearchPalette() {
  const open = useApp((s) => s.searchOpen)
  const setOpen = useApp((s) => s.setSearchOpen)
  const query = useApp((s) => s.searchQuery)
  const hits = useApp((s) => s.searchHits)
  const rooms = useApp((s) => s.rooms)
  const search = useApp((s) => s.search)
  const openRoom = useApp((s) => s.openRoom)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = query.trim()
  const sessions = useMemo(() => (trimmed ? matchSessions(rooms, trimmed) : rooms.slice(0, 6)), [rooms, trimmed])
  const messages = trimmed.length >= 2 ? hits : []
  const items: Item[] = [
    ...sessions.map((r) => ({ key: `s:${r.id}`, open: () => void openRoom(r.id) })),
    ...messages.map((h) => ({ key: `m:${h.messageId}`, open: () => void openRoom(h.roomId, h.messageId) }))
  ]

  useEffect(() => setIndex(0), [trimmed, open])
  // Focus moves into the palette when it opens and back to where it was (the composer or
  // terminal) when it closes, unless choosing a result already put focus somewhere else.
  useEffect(() => {
    if (!open) return
    const before = document.activeElement
    inputRef.current?.focus()
    return () => {
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (!now || now === document.body)) before.focus()
    }
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector('.sp-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null
  const choose = (item?: Item): void => {
    if (!item) return
    setOpen(false)
    item.open()
  }
  const row = (key: string, i: number, body: ReactNode, title?: string) => (
    <button key={key} className={`sp-item ${i === index ? 'on' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => choose(items[i])} title={title}>
      {body}
    </button>
  )

  return (
    <div className="modal-backdrop sp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      {/* Keys are handled for the whole dialog, so they keep working on a result row too.
          Clicking a heading, the footer or empty space would drop focus to the page and
          leave the palette deaf to the keyboard, so those clicks keep focus where it is. */}
      <div
        className="sp"
        role="dialog"
        aria-label="Search"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          const action = paletteKey(e.key)
          if (!action) return
          e.preventDefault()
          e.stopPropagation()
          if (action === 'close') setOpen(false)
          if (action === 'stay') inputRef.current?.focus()
          if (action === 'down') setIndex((i) => Math.min(items.length - 1, i + 1))
          if (action === 'up') setIndex((i) => Math.max(0, i - 1))
          if (action === 'open') choose(items[index])
        }}
        onMouseDown={(e) => {
          if (!(e.target instanceof Element && e.target.closest('button, input'))) e.preventDefault()
        }}
      >
        <div className="sp-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            placeholder="Search sessions and messages"
            value={query}
            onChange={(e) => void search(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="sp-list" ref={listRef}>
          {sessions.length > 0 && <div className="sp-section">{trimmed ? 'Sessions' : 'Recent sessions'}</div>}
          {sessions.map((r, i) =>
            row(`s:${r.id}`, i, (
              <>
                <span className="sp-mark">
                  {r.kind === 'team' ? <Icon name="users" size={14} /> : <AgentMark provider={r.kind} color={r.members[0]?.color} size={16} />}
                </span>
                <span className="sp-main">
                  <span className="sp-title">{r.title}</span>
                  <span className="sp-sub">{basename(r.folder)} · {MODE_LABEL[r.kind]}</span>
                </span>
                <span className="sp-time">{ago(r.updatedAt)}</span>
              </>
            ), r.folder)
          )}
          {messages.length > 0 && <div className="sp-section">Messages</div>}
          {messages.map((h, i) =>
            row(`m:${h.messageId}`, sessions.length + i, (
              <>
                <span className="sp-mark"><Icon name="message" size={14} /></span>
                <span className="sp-main">
                  <span className="sp-snippet"><b>{h.author}:</b> {h.snippet}</span>
                  <span className="sp-sub">{h.roomTitle}</span>
                </span>
                <span className="sp-time">{ago(h.createdAt)}</span>
              </>
            ))
          )}
          {!items.length && <div className="sp-empty">{trimmed ? `Nothing matches "${trimmed}".` : 'No sessions yet.'}</div>}
        </div>
        <div className="sp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>↵</kbd> to open</span>
        </div>
      </div>
    </div>
  )
}
