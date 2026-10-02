// Saves app settings and rooms as JSON files in the app's data folder
// (~/.config/Interface on Ubuntu, ~/Library/Application Support/Interface on macOS).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ROOM_DEFAULTS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type CodexMode,
  type MemberSettings,
  type Room,
  type RoomSummary,
  type SearchHit
} from '@shared/types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE_SETTINGS: AppSettings = {
  claudePath: '',
  codexPath: '',
  accounts: [],
  defaults: DEFAULT_ROOM_DEFAULTS,
  theme: 'system',
  notifications: true,
  recentFolders: []
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1))
  renameSync(tmp, file)
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

const SANDBOX_TO_MODE: Record<string, CodexMode> = { 'read-only': 'read-only', 'workspace-write': 'auto', 'danger-full-access': 'full' }

function memberSettings(saved: Json | undefined): MemberSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
    codexMode: saved?.codexMode ?? SANDBOX_TO_MODE[saved?.sandbox] ?? DEFAULT_SETTINGS.codexMode
  }
}

/** Rooms from the first version had exactly one Claude and one GPT agent. */
function migrateRoom(room: Json): Room {
  if (Array.isArray(room.members)) return room as Room
  const s = room.settings ?? {}
  return {
    id: room.id,
    title: room.title,
    folder: room.folder,
    kind: 'team',
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    pinned: room.pinned,
    members: [
      { id: 'claude', accountId: 'claude-main', provider: 'claude', name: 'Claude', handle: 'claude', color: '#c96442', settings: memberSettings(s.claude) },
      { id: 'codex', accountId: 'codex-main', provider: 'codex', name: 'GPT', handle: 'gpt', color: '#0f8f6f', settings: memberSettings(s.codex) }
    ],
    autoRelay: s.autoRelay ?? true,
    maxHops: s.maxHops ?? 6,
    isolation: false,
    sessions: room.sessions ?? {},
    messages: (room.messages ?? []).map((m: Json) => ({
      ...m,
      handoff: m.handoff ? { ...m.handoff, to: m.handoff.to } : undefined,
      authorName: m.author === 'claude' ? 'Claude' : m.author === 'codex' ? 'GPT' : undefined,
      provider: m.author === 'user' ? undefined : m.author
    }))
  }
}

export class Store {
  private roomsDir: string
  private settingsFile: string
  private timers = new Map<string, NodeJS.Timeout>()
  private rooms = new Map<string, Room>()
  settings: AppSettings

  constructor(dir: string) {
    this.roomsDir = join(dir, 'rooms')
    this.settingsFile = join(dir, 'settings.json')
    mkdirSync(this.roomsDir, { recursive: true })
    const saved = readJson<Json>(this.settingsFile) ?? {}
    this.settings = {
      ...BASE_SETTINGS,
      ...saved,
      accounts: Array.isArray(saved.accounts) ? saved.accounts : [],
      defaults: {
        ...DEFAULT_ROOM_DEFAULTS,
        ...saved.defaults,
        claude: memberSettings(saved.defaults?.claude),
        codex: memberSettings(saved.defaults?.codex)
      }
    }
    this.loadRooms()
  }

  private loadRooms(): void {
    for (const name of readdirSync(this.roomsDir)) {
      if (!name.endsWith('.json')) continue
      const raw = readJson<Json>(join(this.roomsDir, name))
      if (!raw?.id) continue
      const room = migrateRoom(raw)
      // A turn that was running when the app closed can't continue.
      for (const m of room.messages) {
        if (m.status === 'streaming') m.status = 'stopped'
        for (const b of m.blocks) {
          if (b.kind === 'approval' && b.status === 'pending') b.status = 'expired'
          if (b.kind === 'tool' && b.status === 'running') b.status = 'error'
        }
      }
      this.rooms.set(room.id, room)
    }
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch }
    writeAtomic(this.settingsFile, this.settings)
    return this.settings
  }

  addRecentFolder(folder: string): void {
    const recent = [folder, ...this.settings.recentFolders.filter((f) => f !== folder)].slice(0, 12)
    this.saveSettings({ recentFolders: recent })
  }

  summary(room: Room): RoomSummary {
    return {
      id: room.id,
      title: room.title,
      folder: room.folder,
      kind: room.kind,
      updatedAt: room.updatedAt,
      pinned: room.pinned,
      members: room.members.map((m) => ({ id: m.id, name: m.name, provider: m.provider, color: m.color }))
    }
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => this.summary(r)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  all(): Room[] {
    return [...this.rooms.values()]
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id)
  }

  put(room: Room): void {
    this.rooms.set(room.id, room)
    this.saveSoon(room.id)
  }

  /** Writes a room at most every 400 ms while it is streaming. */
  saveSoon(id: string): void {
    if (this.timers.has(id)) return
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.saveNow(id)
      }, 400)
    )
  }

  saveNow(id: string): void {
    const room = this.rooms.get(id)
    if (room) writeAtomic(join(this.roomsDir, `${id}.json`), room)
  }

  flush(): void {
    for (const [id, t] of this.timers) {
      clearTimeout(t)
      this.saveNow(id)
    }
    this.timers.clear()
  }

  delete(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.rooms.delete(id)
    const file = join(this.roomsDir, `${id}.json`)
    if (existsSync(file)) rmSync(file)
  }

  /** Full-text search over every room's messages, newest first. */
  search(query: string, limit = 60): SearchHit[] {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const hits: SearchHit[] = []
    for (const room of this.rooms.values()) {
      for (const m of room.messages) {
        const text = m.text || m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ')
        const i = text.toLowerCase().indexOf(q)
        if (i === -1) continue
        const start = Math.max(0, i - 50)
        const snippet = `${start ? '…' : ''}${text.slice(start, i + q.length + 80).replace(/\s+/g, ' ')}${i + q.length + 80 < text.length ? '…' : ''}`
        hits.push({
          roomId: room.id,
          roomTitle: room.title,
          messageId: m.id,
          author: m.author === 'user' ? 'You' : (m.authorName ?? m.author),
          snippet,
          createdAt: m.createdAt
        })
      }
    }
    return hits.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }
}
