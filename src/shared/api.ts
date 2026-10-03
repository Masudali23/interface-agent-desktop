// The functions the UI can call in the main process (through the preload bridge).

import type {
  Account,
  AgentRuntime,
  AgentsInfo,
  AppEvent,
  AppSettings,
  ApprovalDecision,
  Attachment,
  FileContent,
  FileEntry,
  FileLinkTarget,
  GitState,
  InitialState,
  McpServer,
  MemberSettings,
  Message,
  NewRoomInput,
  Provider,
  Room,
  RoomUpdate,
  SearchHit,
  SendInput
} from './types'

export interface IfaceApi {
  getState(): Promise<InitialState>
  checkAgents(): Promise<AgentsInfo>
  pickFolder(): Promise<string | null>

  // rooms
  createRoom(input: NewRoomInput): Promise<Room>
  getRoom(roomId: string): Promise<{ room: Room; statuses: Record<string, AgentRuntime> } | null>
  renameRoom(roomId: string, title: string): Promise<void>
  pinRoom(roomId: string, pinned: boolean): Promise<void>
  deleteRoom(roomId: string): Promise<void>
  updateRoom(roomId: string, patch: RoomUpdate): Promise<void>
  updateMember(roomId: string, memberId: string, patch: Partial<MemberSettings>): Promise<void>
  addMember(roomId: string, accountId: string): Promise<void>
  removeMember(roomId: string, memberId: string): Promise<void>

  // conversation
  send(roomId: string, input: SendInput): Promise<Message | undefined>
  stop(roomId: string, memberId?: string): Promise<void>
  answer(roomId: string, messageId: string, blockId: string, decision: ApprovalDecision): Promise<void>
  continueHandoff(roomId: string, messageId: string): Promise<void>
  retry(roomId: string, messageId: string): Promise<void>
  editMessage(roomId: string, messageId: string, text: string, undoFiles: boolean): Promise<string>
  undoTurn(roomId: string, messageId: string): Promise<string>
  search(query: string): Promise<SearchHit[]>
  exportChat(roomId: string, action: 'copy' | 'markdown' | 'zip' | 'share'): Promise<{ action: 'copied' | 'saved' | 'shared' | 'canceled'; path?: string; missingAttachments: number }>
  refreshContext(roomId: string, memberId: string): Promise<void>
  mcpList(roomId: string, memberId: string): Promise<McpServer[]>
  mcpToggle(roomId: string, memberId: string, name: string, enabled: boolean): Promise<void>
  mcpReconnect(roomId: string, memberId: string, name: string): Promise<void>

  // accounts
  addAccount(provider: Provider, name: string, handle?: string): Promise<Account>
  updateAccount(accountId: string, patch: Partial<Pick<Account, 'name' | 'handle' | 'color'>>): Promise<void>
  removeAccount(accountId: string, deleteFiles: boolean): Promise<void>
  refreshAccount(accountId: string): Promise<void>
  loginAccount(accountId: string, deviceCode?: boolean): Promise<void>
  submitLoginCode(accountId: string, code: string): Promise<void>
  cancelLogin(accountId: string): Promise<void>
  logoutAccount(accountId: string): Promise<void>
  syncAccount(accountId: string): Promise<string>

  // git
  gitStatus(roomId: string, memberId?: string): Promise<GitState>
  gitDiff(roomId: string, path: string, memberId?: string, oldPath?: string): Promise<string>
  mergeWorktree(roomId: string, memberId: string): Promise<string>
  discardWorktree(roomId: string, memberId: string): Promise<string>

  // files
  resolveFileLink(roomId: string, href: string, memberId?: string, fromFile?: string): Promise<FileLinkTarget>
  listDir(path: string, showHidden?: boolean): Promise<FileEntry[]>
  readFile(path: string): Promise<FileContent>
  watchDir(path: string): Promise<void>
  unwatchDir(path: string): Promise<void>
  searchFiles(roomId: string, query: string): Promise<string[]>
  saveAttachment(roomId: string, name: string, bytes: Uint8Array): Promise<Attachment>

  // terminal
  termCreate(roomId: string | null, accountId: string | null, cols: number, rows: number): Promise<{ id: string; title: string }>
  termWrite(id: string, data: string): Promise<void>
  termResize(id: string, cols: number, rows: number): Promise<void>
  termKill(id: string): Promise<void>

  // app
  saveSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings; agents: AgentsInfo }>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
}

export interface Bridge extends IfaceApi {
  onEvent(cb: (e: AppEvent) => void): () => void
}

export const API_METHODS: Array<keyof IfaceApi> = [
  'getState',
  'checkAgents',
  'pickFolder',
  'createRoom',
  'getRoom',
  'renameRoom',
  'pinRoom',
  'deleteRoom',
  'updateRoom',
  'updateMember',
  'addMember',
  'removeMember',
  'send',
  'stop',
  'answer',
  'continueHandoff',
  'retry',
  'editMessage',
  'undoTurn',
  'search',
  'exportChat',
  'refreshContext',
  'mcpList',
  'mcpToggle',
  'mcpReconnect',
  'addAccount',
  'updateAccount',
  'removeAccount',
  'refreshAccount',
  'loginAccount',
  'submitLoginCode',
  'cancelLogin',
  'logoutAccount',
  'syncAccount',
  'gitStatus',
  'gitDiff',
  'mergeWorktree',
  'discardWorktree',
  'resolveFileLink',
  'listDir',
  'readFile',
  'watchDir',
  'unwatchDir',
  'searchFiles',
  'saveAttachment',
  'termCreate',
  'termWrite',
  'termResize',
  'termKill',
  'saveSettings',
  'openPath',
  'revealPath',
  'openExternal'
]
