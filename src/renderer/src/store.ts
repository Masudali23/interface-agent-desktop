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
import { linkKind } from '@shared/links'

/** Stable empty values for selectors (a new [] on every read would re-render forever). */
export const EMPTY: never[] = []

export type Panel = 'files' | 'tasks' | 'changes' | 'mcp'
export type SettingsTab = 'accounts' | 'defaults' | 'agents' | 'app'
export interface PreviewTarget {
  path: string
  line?: number
  column?: number
  fragment?: string
  isDirectory?: boolean
  memberId?: string
  revision?: number
}
export interface LinkContext { roomId?: string; memberId?: string; fromFile?: string }

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
  preview?: PreviewTarget
  previewHistory: PreviewTarget[]
  previewIndex: number
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
  navigatePreview(index: number): void
  openLink(href: string, context?: LinkContext): Promise<void>
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
let previewSeq = 0

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
            ...(changed && s.followChanges && !s.preview && s.currentRoomId === e.roomId ? {
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
        if (s.currentRoomId === e.roomId) ++previewSeq
        const roomData = { ...s.roomData }
        delete roomData[e.roomId]
        set({
          rooms: s.rooms.filter((r) => r.id !== e.roomId),
          roomData,
          currentRoomId: s.currentRoomId === e.roomId ? undefined : s.currentRoomId,
          ...(s.currentRoomId === e.roomId ? { preview: undefined, previewHistory: [], previewIndex: -1 } : {})
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
    previewHistory: [],
    previewIndex: -1,
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
      ++previewSeq
      if (!id) {
        set({ currentRoomId: undefined, preview: undefined, previewHistory: [], previewIndex: -1, changeTarget: undefined })
        return
      }
      const res = await window.iface.getRoom(id)
      if (!res) return
      set((s) => ({
        currentRoomId: id,
        preview: undefined,
        previewHistory: [],
        previewIndex: -1,
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
      ++previewSeq
      set({ panel, preview: undefined })
    },
    setPreview(preview) {
      const revision = ++previewSeq
      if (!preview) { set({ preview: undefined }); return }
      const target = { ...preview, revision }
      set((s) => {
        const previous = s.previewHistory[s.previewIndex]
        const same = previous && previous.path === target.path && previous.line === target.line && previous.column === target.column && previous.fragment === target.fragment
        const history = same ? s.previewHistory.slice(0, s.previewIndex) : s.previewHistory.slice(0, s.previewIndex + 1)
        history.push(target)
        return { preview: target, previewHistory: history.slice(-50), previewIndex: Math.min(history.length, 50) - 1, panel: s.panel ?? 'files' }
      })
    },
    navigatePreview(index) {
      const target = get().previewHistory[index]
      if (!target) return
      set({ preview: { ...target, revision: ++previewSeq }, previewIndex: index, panel: get().panel ?? 'files' })
    },
    async openLink(href, context = {}) {
      const kind = linkKind(href)
      if (kind === 'web') { await window.iface.openExternal(href.trim()); return }
      if (kind === 'unsupported') throw new Error('This link type cannot be opened in Interface.')
      if (kind === 'anchor' && !context.fromFile) throw new Error('This section is not in the current document.')
      const roomId = context.roomId ?? get().currentRoomId
      if (!roomId) throw new Error('Open a project before opening a local file.')
      const seq = ++previewSeq
      try {
        const target = await window.iface.resolveFileLink(roomId, href, context.memberId, context.fromFile)
        if (seq !== previewSeq || get().currentRoomId !== roomId) return
        get().setPreview({ ...target, memberId: context.memberId })
      } catch (error) {
        if (seq === previewSeq && get().currentRoomId === roomId) throw error
      }
    },
    openChange(path, memberId, messageId) {
      ++previewSeq
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
