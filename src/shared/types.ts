// Types shared by the main process, the preload bridge and the UI.

export type Provider = 'claude' | 'codex'

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

// ---------- accounts ----------

export interface Account {
  id: string
  provider: Provider
  /** Your name for it, e.g. "Work". */
  name: string
  /** Mention handle without "@", unique across accounts. */
  handle: string
  color: string
  /** CLAUDE_CONFIG_DIR / CODEX_HOME. Undefined means the normal ~/.claude or ~/.codex. */
  home?: string
  createdAt: number
}

export interface UsageLimit {
  id: string
  label: string
  /** 0–100 */
  percent: number
  /** ms since epoch */
  resetsAt?: number
  severity?: 'normal' | 'warning' | 'critical'
  detail?: string
}

export interface LoginState {
  state: 'starting' | 'waiting' | 'done' | 'failed'
  url?: string
  /** Codex device-code sign-in shows a code to type in the browser. */
  userCode?: string
  /** Claude asks you to paste the code shown after signing in. */
  needsCode?: boolean
  message?: string
}

export interface AccountInfo {
  loggedIn?: boolean
  email?: string
  plan?: string
  org?: string
  limits: UsageLimit[]
  /** Extra facts such as "Extra usage: off" or "2 free resets". */
  notes: string[]
  checkedAt?: number
  error?: string
  login?: LoginState
}

export interface ModelOption {
  id: string
  label: string
  description?: string
  efforts: string[]
  defaultEffort?: string
  isDefault?: boolean
}

export interface SlashCommand {
  name: string
  description?: string
  argumentHint?: string
}

export interface McpServer {
  name: string
  status: string
  tools?: number
  scope?: string
  error?: string
}

export interface ContextUsage {
  used: number
  max: number
  percent: number
}

// ---------- rooms ----------

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
export type CodexMode = 'read-only' | 'ask' | 'auto' | 'full'

export interface MemberSettings {
  /** '' means the harness default. */
  model: string
  effort: string
  /** Claude only. */
  permissionMode: ClaudePermissionMode
  /** Codex only. */
  codexMode: CodexMode
}

export interface Member {
  id: string
  accountId: string
  provider: Provider
  name: string
  handle: string
  color: string
  settings: MemberSettings
  /** Set when the room gives each agent its own git worktree. */
  worktree?: { path: string; branch: string; base: string }
}

export type RoomKind = 'claude' | 'codex' | 'team'

export type ApprovalStatus = 'pending' | 'allowed' | 'always' | 'denied' | 'answered' | 'expired'

export interface Question {
  id: string
  question: string
  header?: string
  multiSelect?: boolean
  options: Array<{ label: string; description?: string }>
}

export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: unknown
      output?: string
      isError?: boolean
      status: 'running' | 'done' | 'error'
    }
  | {
      kind: 'approval'
      id: string
      requestId: string
      /** What is asking: a Claude tool name, or "command" / "file change" / "permissions" for Codex. */
      toolName: string
      input: unknown
      description?: string
      canAlways: boolean
      questions?: Question[]
      status: ApprovalStatus
      answers?: Record<string, string>
    }
  | { kind: 'error'; id: string; text: string }

export interface Handoff {
  /** A member id, 'user' or 'done'. */
  to: string
  text: string
  overrides?: TurnOverrides
  error?: string
  invalidSettings?: boolean
}

/** Optional settings for a delegated turn; never replace the user's saved choices. */
export interface TurnOverrides {
  model?: string
  effort?: string
}

export interface MessageUsage {
  /** Input read over the whole turn, summed over every model call (cache reads included). */
  inputTokens?: number
  /** The part of inputTokens re-read from the prompt cache. */
  cachedTokens?: number
  /** Output written over the whole turn, reasoning included. */
  outputTokens?: number
  /** Model calls in the turn: one per tool step, plus the final answer. */
  steps?: number
  durationMs?: number
}

/** Where a turn sits in the agent's own session, used for retry, edit and undo. */
export interface TurnRef {
  /** Claude: uuid of the user message that started the turn. Codex: turn id. */
  start?: string
  /** Claude: uuid of the last assistant message of the turn. */
  end?: string
  /** Session/thread the turn belongs to. */
  session?: string
}

export interface Attachment {
  name: string
  path: string
  mime: string
  size: number
}

export interface Message {
  id: string
  /** 'user' or a member id. */
  author: string
  authorName?: string
  provider?: Provider
  color?: string
  createdAt: number
  /** User messages: what was typed. Agent messages: final reply text. */
  text: string
  blocks: Block[]
  status: 'streaming' | 'done' | 'error' | 'stopped'
  /** User messages: member ids it was sent to. */
  to?: string[]
  attachments?: Attachment[]
  handoff?: Handoff
  handoffDone?: boolean
  usage?: MessageUsage
  execution?: { model: string; effort: string; delegated: boolean }
  /** Member ids this message has been forwarded to. */
  deliveredTo?: string[]
  hop?: number
  /** Agent messages: exactly what the agent was sent, for retry. */
  prompt?: { text: string; attachments: Attachment[] }
  turn?: TurnRef
  /** Unified diff of the files this turn changed. */
  diff?: string
  /** Inputs consumed by this turn, including feedback delivered while running. */
  inputMessageIds?: string[]
  /** Another agent worked in this folder during this turn; undo cannot be attributed safely. */
  sharedChanges?: boolean
  /** Git tree snapshots taken before and after a turn (for diff and undo). */
  snapshot?: { before?: string; after?: string }
  /** Files were put back with Undo. */
  undone?: boolean
}

export interface Room {
  id: string
  title: string
  folder: string
  kind: RoomKind
  createdAt: number
  updatedAt: number
  pinned?: boolean
  members: Member[]
  autoRelay: boolean
  maxHops: number
  /** Agents ticked in the composer's "To" row. Messages without @mentions go to these,
   *  and handoffs only run on their own between them. Missing means everyone. */
  active?: string[]
  /** Lead mode sends unmentioned messages to one coordinator; specialists join by handoff. */
  dispatch?: 'parallel' | 'lead'
  leadId?: string
  /** Each agent works in its own git worktree. */
  isolation: boolean
  sessions: Record<string, string>
  messages: Message[]
}

/** Ids of the agents currently taking part (ticked), never empty. */
export function activeMemberIds(room: Pick<Room, 'members' | 'active'>): string[] {
  const all = room.members.map((m) => m.id)
  const ticked = (room.active ?? all).filter((id) => all.includes(id))
  return ticked.length ? ticked : all
}

export type RoomUpdate = Partial<Pick<Room, 'autoRelay' | 'maxHops' | 'active' | 'dispatch' | 'leadId'>>

export function defaultRecipients(room: Pick<Room, 'members' | 'active' | 'dispatch' | 'leadId'>): string[] {
  const active = activeMemberIds(room)
  return room.dispatch === 'lead' ? [active.includes(room.leadId ?? '') ? room.leadId! : active[0]].filter(Boolean) : active
}

export interface RoomSummary {
  id: string
  title: string
  folder: string
  kind: RoomKind
  updatedAt: number
  pinned?: boolean
  members: Array<{ id: string; name: string; provider: Provider; color: string }>
}

export type AgentStatus = 'idle' | 'starting' | 'thinking' | 'working' | 'waiting' | 'error'

export interface AgentRuntime {
  status: AgentStatus
  detail?: string
  queued?: number
  context?: ContextUsage
}

export interface RuntimeMeta {
  models: ModelOption[]
  commands: SlashCommand[]
}

export interface AgentInstall {
  found: boolean
  path?: string
  version?: string
  detail?: string
}

export interface AgentsInfo {
  claude: AgentInstall
  codex: AgentInstall
}

export interface RoomDefaults {
  claude: MemberSettings
  codex: MemberSettings
  autoRelay: boolean
  maxHops: number
}

export interface AppSettings {
  claudePath: string
  codexPath: string
  accounts: Account[]
  defaults: RoomDefaults
  theme: 'system' | 'light' | 'dark'
  notifications: boolean
  recentFolders: string[]
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface FileContent {
  content: string
  truncated: boolean
  binary: boolean
  size: number
}

export interface FileLinkTarget {
  path: string
  line?: number
  column?: number
  fragment?: string
  isDirectory: boolean
}

export interface GitFile {
  path: string
  status: string
  added?: number
  removed?: number
  oldPath?: string
  binary?: boolean
  staged?: boolean
}

export interface GitState {
  isRepo: boolean
  branch?: string
  files: GitFile[]
  error?: string
}

export interface SearchHit {
  roomId: string
  roomTitle: string
  messageId: string
  author: string
  snippet: string
  createdAt: number
}

export interface NewRoomInput {
  folder: string
  kind: RoomKind
  accountIds: string[]
  isolation: boolean
}

export interface SendInput {
  text: string
  to: string[]
  attachments: Attachment[]
}

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'always' }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string> }

/** Events pushed from the main process to the UI. */
export type AppEvent =
  | { type: 'message'; roomId: string; message: Message }
  | { type: 'messages-removed'; roomId: string; messageIds: string[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'room-full'; room: Room }
  | { type: 'room-deleted'; roomId: string }
  | { type: 'agent-status'; roomId: string; memberId: string; runtime: AgentRuntime }
  | { type: 'account-info'; accountId: string; info: AccountInfo }
  | { type: 'meta'; accountId: string; meta: RuntimeMeta }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'dir-changed'; path: string }
  | { type: 'terminal-data'; id: string; data: string }
  | { type: 'terminal-exit'; id: string; code: number }
  | { type: 'menu'; action: 'new-room' | 'open-folder' | 'settings' | 'toggle-sidebar' | 'toggle-terminal' | 'search' }
  | { type: 'open-room'; roomId: string; messageId?: string }

export interface InitialState {
  platform: string
  settings: AppSettings
  rooms: RoomSummary[]
  agents: AgentsInfo
  accountInfo: Record<string, AccountInfo>
  meta: Record<string, RuntimeMeta>
}

export const DEFAULT_SETTINGS: MemberSettings = {
  model: '',
  effort: '',
  permissionMode: 'default',
  codexMode: 'auto'
}

export const DEFAULT_ROOM_DEFAULTS: RoomDefaults = {
  claude: { ...DEFAULT_SETTINGS },
  codex: { ...DEFAULT_SETTINGS },
  autoRelay: true,
  maxHops: 6
}

export const ACCOUNT_COLORS = ['#c96442', '#0f8f6f', '#3b6fd8', '#9b51b8', '#c58a12', '#d0457a', '#2f8fa6', '#6b7a2c']
