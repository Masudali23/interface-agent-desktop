// Pure helpers for the app frame: sidebar grouping, the search palette and shortcuts.

import type { AccountInfo, RoomKind, RoomSummary, UsageLimit } from '@shared/types'

export interface SessionGroups {
  pinned: RoomSummary[]
  folders: Array<{ folder: string; rooms: RoomSummary[] }>
}

/** Splits one mode's sessions into the pinned ones and one group per folder. Groups and
 *  the sessions inside them keep the order of `rooms` (most recently updated first). */
export function groupSessions(rooms: RoomSummary[], mode: RoomKind): SessionGroups {
  const pinned: RoomSummary[] = []
  const byFolder = new Map<string, RoomSummary[]>()
  for (const room of rooms) {
    if (room.kind !== mode) continue
    if (room.pinned) pinned.push(room)
    else byFolder.set(room.folder, [...(byFolder.get(room.folder) ?? []), room])
  }
  return { pinned, folders: [...byFolder].map(([folder, list]) => ({ folder, rooms: list })) }
}

/** Reads a saved list of strings (JSON array); anything unreadable counts as empty. */
export function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function toggleItem(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

/** A collapsed group still shows the open session, so the current place is never hidden. */
export function visibleSessions(rooms: RoomSummary[], collapsed: boolean, activeId?: string): RoomSummary[] {
  return collapsed ? rooms.filter((r) => r.id === activeId) : rooms
}

/** Sessions whose title or folder contains every word of the query, best matches first:
 *  title prefix, then title contains, then folder only. */
export function matchSessions(rooms: RoomSummary[], query: string, limit = 6): RoomSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: Array<{ room: RoomSummary; score: number }> = []
  for (const room of rooms) {
    const title = room.title.toLowerCase()
    const hay = `${title} ${room.folder.toLowerCase()}`
    if (!words.every((w) => hay.includes(w))) continue
    const score = title.startsWith(words[0]) ? 0 : words.every((w) => title.includes(w)) ? 1 : 2
    scored.push({ room, score })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.room)
}

/** The folder that contains `path` ("/work/app" → "/work"), for showing beside its name. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return ''
  return cut === 0 ? trimmed[0] : trimmed.slice(0, cut)
}

/** The usage limit closest to running out. */
export function topLimit(info?: AccountInfo): UsageLimit | undefined {
  let top: UsageLimit | undefined
  for (const limit of info?.limits ?? []) if (!top || limit.percent > top.percent) top = limit
  return top
}

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** ⌘K on macOS, Ctrl+K elsewhere. On Linux Ctrl+K is the shell's kill-line key, so it
 *  is left to an embedded terminal that has focus. */
export function isSearchShortcut(e: KeyLike, platform: string, inTerminal = false): boolean {
  if (inTerminal && platform !== 'darwin') return false
  const mod = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k'
}

/** How a Cmd/Ctrl shortcut is written on this platform, e.g. "⌘K" or "Ctrl+K". */
export function shortcut(platform: string, key: string): string {
  return platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`
}

/** Settings and New session own the keyboard while open, so the palette never stacks on them. */
export function searchBlocked(s: { settingsOpen: boolean; newSession?: unknown }): boolean {
  return s.settingsOpen || !!s.newSession
}

export type PaletteKey = 'close' | 'up' | 'down' | 'open' | 'stay'

/** What a key does anywhere inside the search palette (the input or a result row). Tab
 *  stays on the input, so focus never wanders to the page behind the dialog. */
export function paletteKey(key: string): PaletteKey | undefined {
  if (key === 'Escape') return 'close'
  if (key === 'Tab') return 'stay'
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  if (key === 'Enter') return 'open'
  return undefined
}
