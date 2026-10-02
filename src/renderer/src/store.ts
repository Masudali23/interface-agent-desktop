import { create } from 'zustand'
import type {
  AccountInfo,
  AgentRuntime,
  AgentsInfo,
  AppEvent,
  AppSettings,
  Message,
  Room,
  RoomKind,
  RoomSummary,
  RuntimeMeta,
  SearchHit
} from '@shared/types'
import { terminalBus } from './lib/bus'
import { latestFileActivity } from '@shared/changes'

/** Stable empty values for selectors (a new [] on every read would re-render forever). */
export const EMPTY: never[] = []

export type Panel = 'files' | 'tasks' | 'changes' | 'mcp'
export type SettingsTab = 'accounts' | 'defaults' | 'agents' | 'app'

interface State {
  ready: boolean
  platform: string
  settings?: AppSettings
  agents?: AgentsInfo
  rooms: RoomSummary[]
  accountInfo: Record<string, AccountInfo>
  meta: Record<string, RuntimeMeta>
  mode: RoomKind
  currentRoomId?: string
  roomData: Record<string, Room>
  statuses: Record<string, Record<string, AgentRuntime>>
  sidebarOpen: boolean
  panel: Panel | null
  preview?: { path: string; diff?: { memberId?: string } }
  changeTarget?: { path: string; memberId?: string; messageId?: string }
  followChanges: boolean
  panelWidth: number
  settingsOpen: boolean
  settingsTab: SettingsTab
  newSession?: { folder?: string; kind: RoomKind }
  terminalOpen: boolean
  dirVersion: Record<string, number>
  error?: string
  notice?: string
  searchQuery: string
  searchHits: SearchHit[]
  focusMessageId?: string

  init(): Promise<void>
  openRoom(id: string | undefined, messageId?: string): Promise<void>
  setMode(mode: RoomKind): void
  openNewSession(folder?: string, kind?: RoomKind): void
  closeNewSession(): void
  setPanel(panel: Panel | null): void
  setPreview(preview: State['preview']): void
  openChange(path: string, memberId?: string, messageId?: string): void
  setFollowChanges(follow: boolean): void
  setPanelWidth(width: number): void
  setSidebar(open: boolean): void
  openSettings(tab?: SettingsTab): void
  closeSettings(): void
  setTerminal(open: boolean): void
  setError(error: string | undefined): void
  setNotice(notice: string | undefined): void
  search(query: string): Promise<void>
}

const LAST_ROOM = 'iface.lastRoom'
const MODE = 'iface.mode'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

function upsert(messages: Message[], message: Message): Message[] {
  const i = messages.findIndex((m) => m.id === message.id)
  if (i === -1) return [...messages, message]
  const next = messages.slice()
  next[i] = message
  return next
}

let searchSeq = 0

export const useApp = create<State>((set, get) => {
  const onEvent = (e: AppEvent): void => {
    const s = get()
    switch (e.type) {
      case 'message': {
        const room = s.roomData[e.roomId]
        if (room) {
          const previous = room.messages.find((m) => m.id === e.message.id)
          const activity = latestFileActivity(e.message)
          const changed = activity && activity.key !== (previous && latestFileActivity(previous)?.key)
          set({
            roomData: { ...s.roomData, [e.roomId]: { ...room, messages: upsert(room.messages, e.message) } },
            ...(changed && s.followChanges && s.currentRoomId === e.roomId ? {
              panel: 'changes' as const,
              preview: undefined,
              changeTarget: { path: activity.path, memberId: e.message.author }
            } : {})
          })
        }
        return
      }
      case 'messages-removed': {
        const room = s.roomData[e.roomId]
        if (!room) return
        const gone = new Set(e.messageIds)
        set({ roomData: { ...s.roomData, [e.roomId]: { ...room, messages: room.messages.filter((m) => !gone.has(m.id)) } } })
        return
      }
      case 'room': {
        const rooms = [e.room, ...s.rooms.filter((r) => r.id !== e.room.id)].sort((a, b) => b.updatedAt - a.updatedAt)
        const room = s.roomData[e.room.id]
        set({
          rooms,
          roomData: room ? { ...s.roomData, [e.room.id]: { ...room, title: e.room.title, pinned: e.room.pinned, kind: e.room.kind } } : s.roomData
        })
        return
      }
      case 'room-full': {
        const prev = s.roomData[e.room.id]
        set({ roomData: { ...s.roomData, [e.room.id]: { ...e.room, messages: prev?.messages ?? e.room.messages } } })
        return
      }
      case 'room-deleted': {
        const roomData = { ...s.roomData }
        delete roomData[e.roomId]
        set({
          rooms: s.rooms.filter((r) => r.id !== e.roomId),
          roomData,
          currentRoomId: s.currentRoomId === e.roomId ? undefined : s.currentRoomId
        })
        return
      }
      case 'agent-status':
        set({ statuses: { ...s.statuses, [e.roomId]: { ...s.statuses[e.roomId], [e.memberId]: e.runtime } } })
        return
      case 'account-info':
        set({ accountInfo: { ...s.accountInfo, [e.accountId]: e.info } })
        return
      case 'meta':
        set({ meta: { ...s.meta, [e.accountId]: e.meta } })
        return
      case 'settings':
        set({ settings: e.settings })
        return
      case 'dir-changed':
        set({ dirVersion: { ...s.dirVersion, [e.path]: (s.dirVersion[e.path] ?? 0) + 1 } })
        return
      case 'terminal-data':
        terminalBus.data(e.id, e.data)
        return
      case 'terminal-exit':
        terminalBus.exit(e.id, e.code)
        return
      case 'open-room':
        void get().openRoom(e.roomId, e.messageId)
        return
      case 'menu': {
        const folder = s.currentRoomId ? s.roomData[s.currentRoomId]?.folder : undefined
        if (e.action === 'new-room') get().openNewSession(folder)
        if (e.action === 'open-folder') get().openNewSession()
        if (e.action === 'settings') get().openSettings()
        if (e.action === 'toggle-sidebar') set({ sidebarOpen: !s.sidebarOpen })
        if (e.action === 'toggle-terminal') set({ terminalOpen: !s.terminalOpen })
        if (e.action === 'search') {
          set({ sidebarOpen: true })
          setTimeout(() => document.getElementById('sidebar-search')?.focus(), 50)
        }
        return
      }
    }
  }

  return {
    ready: false,
    platform: 'linux',
    rooms: [],
    accountInfo: {},
    meta: {},
    mode: ((stored(MODE) as RoomKind) || 'team') as RoomKind,
    roomData: {},
    statuses: {},
    sidebarOpen: true,
    panel: null,
    followChanges: stored('iface.followChanges') !== 'false',
    panelWidth: Math.max(320, Math.min(1000, Number(stored('iface.panelWidth')) || 560)),
    settingsOpen: false,
    settingsTab: 'accounts',
    terminalOpen: false,
    dirVersion: {},
    searchQuery: '',
    searchHits: [],

    async init() {
      window.iface.onEvent(onEvent)
      const state = await window.iface.getState()
      set({
        ready: true,
        platform: state.platform,
        settings: state.settings,
        agents: state.agents,
        rooms: state.rooms,
        accountInfo: state.accountInfo,
        meta: state.meta
      })
      document.documentElement.dataset.platform = state.platform
      const last = stored(LAST_ROOM)
      if (last && state.rooms.some((r) => r.id === last)) await get().openRoom(last)
    },

    async openRoom(id, messageId) {
      if (!id) {
        set({ currentRoomId: undefined, preview: undefined, changeTarget: undefined })
        return
      }
      const res = await window.iface.getRoom(id)
      if (!res) return
      set((s) => ({
        currentRoomId: id,
        preview: undefined,
        changeTarget: undefined,
        mode: res.room.kind,
        roomData: { ...s.roomData, [id]: res.room },
        statuses: { ...s.statuses, [id]: res.statuses },
        focusMessageId: messageId
      }))
      store(LAST_ROOM, id)
      store(MODE, res.room.kind)
    },

    setMode(mode) {
      store(MODE, mode)
      set({ mode })
    },
    openNewSession(folder, kind) {
      set((s) => ({ newSession: { folder, kind: kind ?? s.mode } }))
    },
    closeNewSession() {
      set({ newSession: undefined })
    },
    setPanel(panel) {
      set({ panel, preview: undefined })
    },
    setPreview(preview) {
      set((s) => ({ preview, panel: preview ? (s.panel ?? 'files') : s.panel }))
    },
    openChange(path, memberId, messageId) {
      set({ panel: 'changes', preview: undefined, changeTarget: { path, memberId, messageId } })
    },
    setFollowChanges(followChanges) {
      store('iface.followChanges', String(followChanges))
      set({ followChanges })
    },
    setPanelWidth(width) {
      const panelWidth = Math.max(280, Math.min(1000, width))
      store('iface.panelWidth', String(panelWidth))
      set({ panelWidth })
    },
    setSidebar(sidebarOpen) {
      set({ sidebarOpen })
    },
    openSettings(tab) {
      set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab }))
    },
    closeSettings() {
      set({ settingsOpen: false })
    },
    setTerminal(terminalOpen) {
      set({ terminalOpen })
    },
    setError(error) {
      set({ error })
    },
    setNotice(notice) {
      set({ notice })
      if (notice) setTimeout(() => get().notice === notice && set({ notice: undefined }), 5000)
    },
    async search(query) {
      const seq = ++searchSeq
      set({ searchQuery: query })
      if (query.trim().length < 2) {
        set({ searchHits: [] })
        return
      }
      const hits = await window.iface.search(query)
      if (seq === searchSeq) set({ searchHits: hits })
    }
  }
})

/** Runs an API call and shows its error in the toast. */
export async function act<T>(fn: () => Promise<T>, success?: (r: T) => string | undefined): Promise<T | undefined> {
  try {
    const r = await fn()
    const msg = success?.(r)
    if (msg) useApp.getState().setNotice(msg)
    return r
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useApp.getState().setError(message.replace(/^Error invoking remote method 'api': (Error: )?/, ''))
    return undefined
  }
}
