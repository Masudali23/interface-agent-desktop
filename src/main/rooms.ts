// The room orchestrator. It keeps the shared conversation, decides which agent works
// next, forwards to each agent what it hasn't seen yet, follows hand-offs, and handles
// retry, edit, undo and per-agent worktrees.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  activeMemberIds,
  defaultRecipients,
  type AgentRuntime,
  type AgentStatus,
  type AppEvent,
  type ApprovalDecision,
  type Attachment,
  type Block,
  type Handoff,
  type McpServer,
  type Member,
  type MemberSettings,
  type Message,
  type NewRoomInput,
  type Provider,
  type Room,
  type RoomUpdate,
  type TurnOverrides,
  type SendInput
} from '@shared/types'
import type { AccountManager } from './accounts'
import { ClaudeAgent } from './agents/claude'
import { CodexAgent } from './agents/codex'
import { CodexExecAgent } from './agents/codexExec'
import type { AgentConnector, AgentEvent } from './agents/types'
import { addWorktree, diffTrees, mergeWorktree, removeWorktree, resetWorktree, restoreTree, snapshot } from './git'
import { collabDir, formatUpdate, isTeam, parseHandoff, pendingFor, renderMessage, systemPrompt, textOf, titleFrom } from './protocol'
import type { Store } from './store'

export interface RoomHost {
  emit(e: AppEvent): void
  notify(title: string, body: string, roomId: string): void
  binaries(): Partial<Record<Provider, string>>
  codexAppServer(): boolean
  dataDir: string
}

interface Job {
  memberId: string
  hop: number
  retried?: boolean
  overrides?: TurnOverrides
  canceled?: boolean
  sourceMessageId?: string
  /** Send exactly this instead of the room update (retry, slash commands). */
  raw?: { text: string; attachments: Attachment[] }
  /** Codex harness command such as /review. */
  command?: { name: string; args: string }
}

interface Runtime {
  connectors: Map<string, AgentConnector>
  current: Map<string, Message>
  jobs: Map<string, Job>
  queue: Map<string, Job[]>
  status: Map<string, AgentRuntime>
}

/** The member's mode says never ask: Codex "Full access" or Claude "Bypass permissions". */
export const neverAsks = (member: Member): boolean =>
  member.provider === 'codex' ? member.settings.codexMode === 'full' : member.settings.permissionMode === 'bypassPermissions'

const id = (prefix: string): string => `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

const TASKS_TEMPLATE = `# Task board

<!-- The agents keep this list up to date. One task per line:
- [ ] description — owner: @handle — files: path/one, path/two
-->
`

export class RoomManager {
  private runtimes = new Map<string, Runtime>()
  private emitTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private store: Store,
    private accounts: AccountManager,
    private host: RoomHost
  ) {}

  // ---------- rooms ----------

  private runtime(roomId: string): Runtime {
    let rt = this.runtimes.get(roomId)
    if (!rt) {
      rt = { connectors: new Map(), current: new Map(), jobs: new Map(), queue: new Map(), status: new Map() }
      this.runtimes.set(roomId, rt)
    }
    return rt
  }

  statuses(roomId: string): Record<string, AgentRuntime> {
    const room = this.get(roomId)
    const rt = this.runtime(roomId)
    return Object.fromEntries((room?.members ?? []).map((m) => [m.id, rt.status.get(m.id) ?? { status: 'idle' as const }]))
  }

  private collab(room: Room): string {
    return join(room.folder, collabDir(room.id))
  }

  private prepareCollab(room: Room): void {
    try {
      const root = join(room.folder, '.collab')
      const dir = this.collab(room)
      mkdirSync(join(dir, 'attachments'), { recursive: true })
      // Keeps .collab out of git without touching the project's own .gitignore.
      if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n')
      if (isTeam(room) && !existsSync(join(dir, 'tasks.md'))) writeFileSync(join(dir, 'tasks.md'), TASKS_TEMPLATE)
      if (!existsSync(join(dir, 'chat.md'))) writeFileSync(join(dir, 'chat.md'), '# Room transcript\n\n')
      writeFileSync(join(dir, 'models.json'), JSON.stringify(room.members.map((member) => ({
        handle: member.handle, provider: member.provider, selected: activeMemberIds(room).includes(member.id),
        current: { model: member.settings.model || 'default', effort: member.settings.effort || 'default' },
        models: this.accounts.meta.get(member.accountId)?.models ?? []
      })), null, 2))
    } catch {
      // Read-only folder: the room still works, without the shared files.
    }
  }

  private memberFor(room: Room, accountId: string): Member {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error('That account no longer exists.')
    const taken = new Set(room.members.map((m) => m.handle))
    let handle = account.handle
    for (let i = 2; taken.has(handle); i++) handle = `${account.handle}-${i}`
    return {
      id: id('a'),
      accountId,
      provider: account.provider,
      name: taken.has(account.handle) ? `${account.name} ${handle.split('-').pop()}` : account.name,
      handle,
      color: account.color,
      settings: { ...this.store.settings.defaults[account.provider] }
    }
  }

  async create(input: NewRoomInput): Promise<Room> {
    const now = Date.now()
    const defaults = this.store.settings.defaults
    const room: Room = {
      id: id('r'),
      title: 'New session',
      folder: input.folder,
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
      members: [],
      autoRelay: defaults.autoRelay,
      maxHops: defaults.maxHops,
      isolation: input.isolation && input.kind === 'team',
      sessions: {},
      messages: []
    }
    const ids = input.kind === 'team' ? input.accountIds : input.accountIds.slice(0, 1)
    if (!ids.length) throw new Error('Pick at least one account.')
    for (const accountId of ids) room.members.push(this.memberFor(room, accountId))
    if (room.kind === 'team') { room.dispatch = 'lead'; room.leadId = room.members[0].id }
    if (room.isolation) await this.createWorktrees(room)
    this.prepareCollab(room)
    this.store.put(room)
    this.store.saveNow(room.id)
    this.store.addRecentFolder(input.folder)
    this.host.emit({ type: 'settings', settings: this.store.settings })
    this.emitRoom(room)
    return room
  }

  private async createWorktrees(room: Room): Promise<void> {
    for (const m of room.members) {
      if (m.worktree) continue
      const path = join(this.host.dataDir, 'worktrees', room.id, m.handle)
      const branch = `interface/${room.id}/${m.handle}`
      const { base } = await addWorktree(room.folder, path, branch)
      m.worktree = { path, branch, base }
    }
  }

  get(roomId: string): Room | undefined {
    return this.store.get(roomId)
  }

  private touch(room: Room): void {
    room.updatedAt = Date.now()
    this.store.saveSoon(room.id)
    this.emitRoom(room)
  }

  private emitRoom(room: Room): void {
    this.host.emit({ type: 'room', room: this.store.summary(room) })
  }

  private emitFull(room: Room): void {
    this.host.emit({ type: 'room-full', room })
    this.emitRoom(room)
  }

  rename(roomId: string, title: string): void {
    const room = this.get(roomId)
    if (!room) return
    room.title = title.trim() || room.title
    this.touch(room)
  }

  pin(roomId: string, pinned: boolean): void {
    const room = this.get(roomId)
    if (!room) return
    room.pinned = pinned
    this.store.saveSoon(room.id)
    this.emitRoom(room)
  }

  async delete(roomId: string): Promise<void> {
    const room = this.get(roomId)
    this.disposeRuntime(roomId)
    if (room) for (const m of room.members) if (m.worktree) await removeWorktree(room.folder, m.worktree.path, m.worktree.branch)
    this.store.delete(roomId)
    this.host.emit({ type: 'room-deleted', roomId })
  }

  updateRoom(roomId: string, patch: RoomUpdate): void {
    const room = this.get(roomId)
    if (!room) return
    if (patch.active !== undefined) {
      const ids = patch.active.filter((id) => room.members.some((m) => m.id === id))
      room.active = ids.length ? ids : undefined
    }
    if (patch.autoRelay !== undefined) room.autoRelay = patch.autoRelay
    if (patch.maxHops !== undefined && Number.isFinite(patch.maxHops)) room.maxHops = Math.max(0, Math.min(30, Math.floor(patch.maxHops)))
    if (patch.dispatch === 'parallel' || patch.dispatch === 'lead') room.dispatch = patch.dispatch
    if (patch.leadId !== undefined && room.members.some((member) => member.id === patch.leadId)) room.leadId = patch.leadId
    this.refreshPrompts(room)
    this.prepareCollab(room)
    this.store.saveSoon(roomId)
    this.emitFull(room)
  }

  updateMember(roomId: string, memberId: string, patch: Partial<MemberSettings>): void {
    const room = this.get(roomId)
    const member = room?.members.find((m) => m.id === memberId)
    if (!room || !member) return
    member.settings = { ...member.settings, ...patch }
    this.runtime(roomId).connectors.get(memberId)?.update(member.settings, systemPrompt(member, room))
    // Switching to full access mid-turn also lets through what is already waiting.
    const current = this.runtime(roomId).current.get(memberId)
    if (current && neverAsks(member)) {
      for (const b of current.blocks) {
        if (b.kind === 'approval' && b.status === 'pending' && !b.questions) this.answer(roomId, current.id, b.id, { kind: 'allow' })
      }
    }
    this.store.saveSoon(roomId)
    this.prepareCollab(room)
    this.emitFull(room)
  }

  async addMember(roomId: string, accountId: string): Promise<void> {
    const room = this.get(roomId)
    if (!room) return
    room.members.push(this.memberFor(room, accountId))
    room.kind = 'team'
    if (room.isolation) await this.createWorktrees(room)
    this.prepareCollab(room)
    this.refreshPrompts(room)
    this.touch(room)
    this.emitFull(room)
  }

  removeMember(roomId: string, memberId: string): void {
    const room = this.get(roomId)
    if (!room || room.members.length < 2) throw new Error('A session needs at least one agent.')
    const rt = this.runtime(roomId)
    if (rt.current.has(memberId)) throw new Error('Stop that agent first.')
    rt.connectors.get(memberId)?.dispose()
    rt.connectors.delete(memberId)
    room.members = room.members.filter((m) => m.id !== memberId)
    this.refreshPrompts(room)
    this.touch(room)
    this.emitFull(room)
  }

  /** The member list changed: tell every agent about the new participants. */
  private refreshPrompts(room: Room): void {
    const rt = this.runtime(room.id)
    for (const m of room.members) rt.connectors.get(m.id)?.update(m.settings, systemPrompt(m, room))
  }

  attachmentDir(roomId: string): string | undefined {
    const room = this.get(roomId)
    return room ? join(this.collab(room), 'attachments') : undefined
  }

  /** Folders the file panel may read: the project and every agent worktree. */
  roots(): string[] {
    return this.store.all().flatMap((r) => [r.folder, ...r.members.flatMap((m) => (m.worktree ? [m.worktree.path] : []))])
  }

  // ---------- messages ----------

  private emitMessage(roomId: string, message: Message, now = false): void {
    const key = message.id
    if (now) {
      clearTimeout(this.emitTimers.get(key))
      this.emitTimers.delete(key)
      this.host.emit({ type: 'message', roomId, message })
      return
    }
    if (this.emitTimers.has(key)) return
    this.emitTimers.set(
      key,
      setTimeout(() => {
        this.emitTimers.delete(key)
        this.host.emit({ type: 'message', roomId, message })
      }, 60)
    )
  }

  private transcript(room: Room, message: Message): void {
    try {
      appendFileSync(join(this.collab(room), 'chat.md'), `${renderMessage(message, room, true)}\n\n`)
    } catch {
      // Folder not writable.
    }
  }

  send(roomId: string, input: SendInput): Message | undefined {
    const room = this.get(roomId)
    if (!room) return undefined
    let to = input.to.filter((t) => room.members.some((m) => m.id === t))
    if (!to.length) to = defaultRecipients(room)
    const message: Message = {
      id: id('m'),
      author: 'user',
      createdAt: Date.now(),
      text: input.text,
      blocks: [],
      status: 'done',
      to,
      attachments: input.attachments,
      deliveredTo: []
    }
    if (room.title === 'New session' && !room.messages.some((m) => m.author === 'user')) room.title = titleFrom(input.text)
    room.messages.push(message)
    this.prepareCollab(room)
    this.transcript(room, message)
    this.emitMessage(roomId, message, true)
    this.touch(room)

    // Slash commands go to the harness as typed, not wrapped in a room update.
    const slash = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(input.text.trim())
    for (const memberId of to) {
      const member = room.members.find((m) => m.id === memberId)!
      if (slash && member.provider === 'codex' && (slash[1] === 'review' || slash[1] === 'compact')) {
        message.deliveredTo = [...(message.deliveredTo ?? []), memberId]
        this.enqueue(room, { memberId, hop: 0, command: { name: slash[1], args: slash[2] } })
      } else if (slash && member.provider === 'claude') {
        message.deliveredTo = [...(message.deliveredTo ?? []), memberId]
        this.enqueue(room, { memberId, hop: 0, raw: { text: input.text.trim(), attachments: input.attachments } })
      } else if (!this.steer(room, memberId)) {
        this.enqueue(room, { memberId, hop: 0 })
      }
    }
    return message
  }

  /** Gives a user message to an agent mid-turn instead of waiting for the turn to end. */
  private steer(room: Room, memberId: string): boolean {
    const rt = this.runtime(room.id)
    const current = rt.current.get(memberId)
    const member = room.members.find((m) => m.id === memberId)
    const c = rt.connectors.get(memberId)
    if (!current || !member || !c?.steer || current.status !== 'streaming') return false
    const pending = pendingFor(memberId, room.messages).filter((m) => m.handoff?.to !== memberId)
    if (!pending.length) return false
    const text = formatUpdate(member, pending, room, false)
    const attachments = pending.filter((m) => m.author === 'user' && (m.to ?? []).includes(memberId)).flatMap((m) => m.attachments ?? [])
    const job = rt.jobs.get(memberId)
    for (const m of pending) m.deliveredTo = [...(m.deliveredTo ?? []), memberId]
    void c.steer({ text, images: attachments }).catch(() => false).then((ok) => {
      if (ok) {
        current.prompt = { text: `${current.prompt?.text ?? ''}\n\n${text}`, attachments: [...(current.prompt?.attachments ?? []), ...attachments] }
        current.inputMessageIds = [...new Set([...(current.inputMessageIds ?? []), ...pending.map((m) => m.id)])]
        this.store.saveSoon(room.id)
        return
      }
      // The turn ended first: deliver it as the next turn instead.
      for (const m of pending) m.deliveredTo = (m.deliveredTo ?? []).filter((x) => x !== memberId)
      if (!job?.canceled && this.runtimes.get(room.id) === rt) this.enqueue(room, { memberId, hop: 0 })
    })
    return true
  }

  continueHandoff(roomId: string, messageId: string): void {
    const room = this.get(roomId)
    const message = room?.messages.find((m) => m.id === messageId)
    if (!room || !message?.handoff || message.handoffDone) return
    const to = message.handoff.to
    if (!room.members.some((m) => m.id === to)) return
    const problem = (!message.handoff.invalidSettings && message.handoff.error) || this.validateOverrides(room, to, message.handoff.overrides)
    if (problem) throw new Error(problem)
    message.handoff.error = undefined
    message.handoff.invalidSettings = undefined
    message.handoffDone = true
    this.emitMessage(roomId, message, true)
    this.enqueue(room, { memberId: to, hop: 0, overrides: message.handoff.overrides, sourceMessageId: message.id })
  }

  // ---------- running agents ----------

  private validateOverrides(room: Room, memberId: string, overrides?: TurnOverrides): string | undefined {
    if (!overrides) return
    const member = room.members.find((m) => m.id === memberId)
    if (!member) return 'The requested agent is no longer in this session.'
    const models = this.accounts.meta.get(member.accountId)?.models ?? []
    const requested = overrides.model ?? member.settings.model
    const model = requested ? models.find((m) => m.id === requested) : models.find((m) => m.isDefault)
    if (overrides.model && !model) return `Model ${overrides.model} is not available for ${member.name}. Refresh the account's model list.`
    const effort = overrides.effort ?? member.settings.effort
    if (effort && !(model?.efforts.includes(effort) || !model && effort === member.settings.effort && overrides.model === undefined)) return `Effort ${effort} is not supported by this model. Choose a supported effort explicitly.`
  }

  private setStatus(roomId: string, memberId: string, status: AgentStatus, detail?: string): void {
    const rt = this.runtime(roomId)
    const prev = rt.status.get(memberId)
    const next: AgentRuntime = { ...prev, status, detail, queued: rt.queue.get(memberId)?.length ?? 0 }
    rt.status.set(memberId, next)
    this.host.emit({ type: 'agent-status', roomId, memberId, runtime: next })
  }

  private enqueue(room: Room, job: Job, front = false): void {
    const rt = this.runtime(room.id)
    const q = rt.queue.get(job.memberId) ?? []
    // Plain jobs collect every pending message anyway, so one queued is enough.
    if (job.raw || job.command || job.sourceMessageId || job.overrides || !q.some((j) => !j.raw && !j.command && !j.sourceMessageId && !j.overrides)) {
      if (front) q.unshift(job)
      else q.push(job)
    }
    rt.queue.set(job.memberId, q)
    const st = rt.status.get(job.memberId)
    if (rt.current.has(job.memberId) && st) this.setStatus(room.id, job.memberId, st.status, st.detail)
    this.pump(room, job.memberId)
  }

  private pump(room: Room, memberId: string): void {
    const rt = this.runtime(room.id)
    if (rt.current.has(memberId)) return
    const job = rt.queue.get(memberId)?.shift()
    if (!job) {
      if (rt.status.get(memberId)?.status !== 'error') this.setStatus(room.id, memberId, 'idle')
      return
    }
    this.startTurn(room, memberId, job)
  }

  private connector(room: Room, member: Member): AgentConnector | string {
    const rt = this.runtime(room.id)
    const existing = rt.connectors.get(member.id)
    if (existing) return existing
    const account = this.accounts.get(member.accountId)
    if (!account) return `The account for ${member.name} was removed. Add it again or remove this agent.`
    const binary = this.host.binaries()[member.provider]
    if (!binary) {
      return member.provider === 'claude'
        ? "Claude Code (`claude`) wasn't found. Install it, or set its path in Settings."
        : "Codex (`codex`) wasn't found. Install it, or set its path in Settings."
    }
    const cwd = member.worktree?.path ?? room.folder
    const shared = room.isolation ? [this.collab(room)] : []
    const env = this.accounts.env(account)
    let c: AgentConnector
    if (member.provider === 'claude') {
      c = new ClaudeAgent({
        binary,
        cwd,
        env,
        settings: member.settings,
        sessionId: room.sessions[member.id],
        systemPrompt: systemPrompt(member, room),
        addDirs: shared
      })
    } else if (this.host.codexAppServer()) {
      const server = this.accounts.codexServer(account.id)
      if (!server) return "Codex (`codex`) wasn't found."
      c = new CodexAgent({
        server,
        cwd,
        settings: member.settings,
        threadId: room.sessions[member.id],
        developerInstructions: systemPrompt(member, room),
        writableRoots: shared,
        defaultModel: () => this.accounts.defaultModel(account.id)
      })
    } else {
      c = new CodexExecAgent({ binary, cwd, env, settings: member.settings, threadId: room.sessions[member.id] })
    }
    c.on('event', (e: AgentEvent) => this.onAgentEvent(room.id, member.id, e))
    rt.connectors.set(member.id, c)
    return c
  }

  private startTurn(room: Room, memberId: string, job: Job): void {
    const rt = this.runtime(room.id)
    const member = room.members.find((m) => m.id === memberId)
    if (!member) return
    const pending = job.raw || job.command ? [] : pendingFor(memberId, room.messages).filter((m) => m.handoff?.to !== memberId || m.id === job.sourceMessageId)
    if (!job.raw && !job.command && !pending.length) return this.pump(room, memberId)

    const firstTurn = !room.sessions[memberId]
    const execRules = member.provider === 'codex' && !this.host.codexAppServer() && firstTurn
    const prompt = job.raw ?? {
      text: formatUpdate(member, pending, room, execRules),
      attachments: pending.filter((m) => m.author === 'user' && (m.to ?? []).includes(memberId)).flatMap((m) => m.attachments ?? [])
    }
    const message: Message = {
      id: id('m'),
      author: memberId,
      authorName: member.name,
      provider: member.provider,
      color: member.color,
      createdAt: Date.now(),
      text: '',
      blocks: [],
      status: 'streaming',
      hop: job.hop,
      deliveredTo: [],
      prompt,
      inputMessageIds: pending.map((m) => m.id),
      turn: {}
    }
    message.execution = { model: job.overrides?.model ?? member.settings.model, effort: job.overrides?.effort ?? member.settings.effort, delegated: !!job.overrides }

    const c = this.connector(room, member)
    if (typeof c === 'string') {
      message.status = 'error'
      message.blocks.push({ kind: 'error', id: id('b'), text: c })
      room.messages.push(message)
      this.emitMessage(room.id, message, true)
      this.setStatus(room.id, memberId, 'error', 'not available')
      return
    }

    const folder = member.worktree?.path ?? room.folder
    for (const [otherRoomId, otherRuntime] of this.runtimes) {
      const otherRoom = this.get(otherRoomId)
      if (!otherRoom) continue
      for (const [otherId, otherMessage] of otherRuntime.current) {
        const otherMember = otherRoom.members.find((m) => m.id === otherId)
        if (otherMember && (otherMember.worktree?.path ?? otherRoom.folder) === folder) {
          message.sharedChanges = true
          otherMessage.sharedChanges = true
          this.emitMessage(otherRoomId, otherMessage, true)
          this.store.saveSoon(otherRoomId)
        }
      }
    }
    for (const m of pending) m.deliveredTo = [...(m.deliveredTo ?? []), memberId]
    room.messages.push(message)
    rt.current.set(memberId, message)
    rt.jobs.set(memberId, job)
    this.emitMessage(room.id, message, true)
    this.setStatus(room.id, memberId, 'starting')
    this.touch(room)
    const go = (): void => {
      if (job.canceled || this.runtimes.get(room.id) !== rt || rt.current.get(memberId) !== message) return
      const invalid = this.validateOverrides(room, memberId, job.overrides)
      if (invalid) { this.finishTurn(room, memberId, { t: 'turn-end', ok: false, error: invalid }); return }
      message.execution = { model: job.overrides?.model ?? member.settings.model, effort: job.overrides?.effort ?? member.settings.effort, delegated: !!job.overrides }
      if (job.command && c.command?.(job.command.name, job.command.args)) return
      c.send({ text: prompt.text, images: prompt.attachments, overrides: job.overrides })
    }
    // Snapshots capture shell edits for both providers. A shared folder can include
    // concurrent agents' changes, so it is described as a turn snapshot in the UI.
    void snapshot(member.worktree?.path ?? room.folder)
      .then((before) => {
        if (before && !job.canceled) message.snapshot = { before }
      })
      .catch(() => {})
      .finally(go)
  }

  /** Diff the folder against the snapshot taken before this turn. */
  private async finishSnapshot(room: Room, member: Member, message: Message): Promise<void> {
    const before = message.snapshot?.before
    if (!before) return
    const cwd = member.worktree?.path ?? room.folder
    const after = await snapshot(cwd)
    if (!after) return
    message.snapshot = { before, after }
    if (after !== before) message.diff = await diffTrees(cwd, before, after)
    this.emitMessage(room.id, message, true)
    this.store.saveSoon(room.id)
  }

  private block<K extends Block['kind']>(message: Message, blockId: string, kind: K): Extract<Block, { kind: K }> | undefined {
    return message.blocks.find((b) => b.id === blockId && b.kind === kind) as Extract<Block, { kind: K }> | undefined
  }

  private onAgentEvent(roomId: string, memberId: string, e: AgentEvent): void {
    const room = this.get(roomId)
    const member = room?.members.find((m) => m.id === memberId)
    if (!room || !member) return
    const rt = this.runtime(roomId)
    const message = rt.current.get(memberId)

    switch (e.t) {
      case 'session':
        room.sessions[memberId] = e.id
        if (message?.turn) message.turn.session = e.id
        this.store.saveSoon(roomId)
        return
      case 'session-invalid':
        return this.restartWithoutSession(room, memberId)
      case 'meta':
        this.accounts.setMeta(member.accountId, e.meta)
        if (e.account) this.accounts.fromAgent(member.accountId, e.account)
        return
      case 'account':
        this.accounts.fromAgent(member.accountId, e.info)
        return
      case 'status':
        this.setStatus(roomId, memberId, e.status, e.detail)
        return
      case 'context': {
        const st = rt.status.get(memberId) ?? { status: 'idle' as const }
        rt.status.set(memberId, { ...st, context: e.context })
        this.host.emit({ type: 'agent-status', roomId, memberId, runtime: rt.status.get(memberId)! })
        return
      }
      case 'turn-end':
        return this.finishTurn(room, memberId, e)
    }

    if (!message) return
    switch (e.t) {
      case 'turn-ref':
        message.turn = { ...message.turn, ...(e.start && !message.turn?.start ? { start: e.start } : {}), ...(e.end ? { end: e.end } : {}) }
        this.store.saveSoon(roomId)
        return
      case 'diff':
        message.diff = e.diff
        break
      case 'block-start':
        if (!message.blocks.some((b) => b.id === e.key)) message.blocks.push({ kind: e.kind, id: e.key, text: '' })
        break
      case 'delta': {
        const b = message.blocks.find((x) => x.id === e.key)
        if (b && (b.kind === 'text' || b.kind === 'thinking')) b.text += e.text
        break
      }
      case 'block-set': {
        const b = message.blocks.find((x) => x.id === e.key)
        if (b && (b.kind === 'text' || b.kind === 'thinking')) b.text = e.text
        else message.blocks.push({ kind: e.kind, id: e.key, text: e.text })
        break
      }
      case 'tool-start':
        if (!this.block(message, e.id, 'tool')) message.blocks.push({ kind: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' })
        break
      case 'tool-input': {
        const b = this.block(message, e.id, 'tool')
        if (b) {
          b.input = e.input
          b.name = e.name
        } else message.blocks.push({ kind: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' })
        break
      }
      case 'tool-output': {
        const b = this.block(message, e.id, 'tool')
        if (b) b.output = ((b.output ?? '') + e.text).slice(-20000)
        break
      }
      case 'tool-end': {
        const b = this.block(message, e.id, 'tool')
        if (b) {
          if (e.output !== undefined) b.output = e.output
          b.isError = e.isError
          b.status = e.isError ? 'error' : 'done'
        }
        break
      }
      case 'approval': {
        const at = e.toolUseId ? message.blocks.findIndex((b) => b.id === e.toolUseId) : -1
        // Full access (Codex) or Bypass (Claude) means never ask, even for a turn that
        // started under a stricter mode. Questions for the user still wait.
        if (neverAsks(member) && !e.questions) {
          message.blocks.splice(at === -1 ? message.blocks.length : at + 1, 0, {
            kind: 'approval',
            id: id('b'),
            requestId: e.requestId,
            toolName: e.toolName,
            input: e.input,
            description: e.description,
            canAlways: e.canAlways,
            status: 'allowed'
          })
          this.runtime(roomId).connectors.get(memberId)?.answer(e.requestId, { kind: 'allow' })
          this.emitMessage(roomId, message, true)
          this.store.saveSoon(roomId)
          return
        }
        message.blocks.splice(at === -1 ? message.blocks.length : at + 1, 0, {
          kind: 'approval',
          id: id('b'),
          requestId: e.requestId,
          toolName: e.toolName,
          input: e.input,
          description: e.description,
          canAlways: e.canAlways,
          questions: e.questions,
          status: 'pending'
        })
        this.emitMessage(roomId, message, true)
        this.host.notify(`${member.name} needs you`, `${e.questions ? 'Has a question' : `Wants to use ${e.toolName}`}${e.description ? `: ${e.description}` : ''}`, roomId)
        this.store.saveSoon(roomId)
        return
      }
      case 'approvals-expired':
        for (const b of message.blocks) if (b.kind === 'approval' && b.status === 'pending') b.status = 'expired'
        break
    }
    this.emitMessage(roomId, message)
    this.store.saveSoon(roomId)
  }

  private restartWithoutSession(room: Room, memberId: string): void {
    const rt = this.runtime(room.id)
    const message = rt.current.get(memberId)
    const job = rt.jobs.get(memberId) ?? { memberId, hop: 0 }
    rt.current.delete(memberId)
    rt.jobs.delete(memberId)
    if (message) {
      room.messages = room.messages.filter((m) => m.id !== message.id)
      this.host.emit({ type: 'messages-removed', roomId: room.id, messageIds: [message.id] })
    }
    delete room.sessions[memberId]
    // The saved session is gone (for example on another computer): resend recent history.
    for (const m of room.messages.slice(-40)) m.deliveredTo = (m.deliveredTo ?? []).filter((a) => a !== memberId)
    rt.connectors.get(memberId)?.dispose()
    rt.connectors.delete(memberId)
    if (!job.retried) this.enqueue(room, { ...job, raw: undefined, retried: true }, true)
    else this.pump(room, memberId)
  }

  private finishTurn(room: Room, memberId: string, e: Extract<AgentEvent, { t: 'turn-end' }>): void {
    const rt = this.runtime(room.id)
    const member = room.members.find((m) => m.id === memberId)
    const message = rt.current.get(memberId)
    const job = rt.jobs.get(memberId)
    if (!message || !member) { rt.current.delete(memberId); rt.jobs.delete(memberId); return this.pump(room, memberId) }
    if (message.status !== 'streaming') return

    for (const b of message.blocks) {
      if (b.kind === 'tool' && b.status === 'running') b.status = e.ok ? 'done' : 'error'
      if (b.kind === 'approval' && b.status === 'pending') b.status = 'expired'
    }
    if (e.error) message.blocks.push({ kind: 'error', id: id('b'), text: e.error })
    message.status = e.stopped ? 'stopped' : e.ok ? 'done' : 'error'
    message.usage = e.usage

    // Read the routing line and hide it from the reply. Agents sometimes also end an
    // in-between message with one, so every text block is checked and the last one wins.
    let handoff: Handoff | undefined
    if (isTeam(room)) {
      for (const b of message.blocks) {
        if (b.kind !== 'text') continue
        const parsed = parseHandoff(b.text, room, memberId)
        if (parsed.handoff) {
          handoff = parsed.handoff
          b.text = parsed.body
        }
      }
    }
    message.text = textOf(message.blocks)
    message.handoff = handoff
    if (handoff && !handoff.error && room.members.some((m) => m.id === handoff.to)) {
      handoff.error = this.validateOverrides(room, handoff.to, handoff.overrides)
      if (handoff.error) handoff.invalidSettings = true
    }

    const target = handoff?.to
    const relay =
      message.status === 'done' &&
      !handoff?.error &&
      !!target &&
      target !== memberId &&
      room.members.some((m) => m.id === target) &&
      // An unticked agent is sitting this out: leave the "Send to" button for the user.
      activeMemberIds(room).includes(target) &&
      room.autoRelay &&
      (message.hop ?? 0) < room.maxHops
    if (relay) message.handoffDone = true

    this.emitMessage(room.id, message, true)
    this.transcript(room, message)
    this.touch(room)
    this.store.saveSoon(room.id)
    const finish = this.finishSnapshot(room, member, message).catch(() => {})

    if (message.status !== 'stopped') {
      const snippet = (message.text || e.error || '').replace(/\s+/g, ' ').slice(0, 120)
      this.host.notify(`${member.name} ${message.status === 'error' ? 'hit an error' : 'replied'}`, snippet, room.id)
    }
    this.setStatus(room.id, memberId, message.status === 'error' ? 'error' : 'idle', message.status === 'error' ? 'last turn failed' : undefined)
    void finish.then(() => {
      if (this.runtimes.get(room.id) !== rt || rt.current.get(memberId) !== message) return
      rt.current.delete(memberId)
      rt.jobs.delete(memberId)
      if (relay && !job?.canceled) this.enqueue(room, { memberId: target!, hop: (message.hop ?? 0) + 1, overrides: handoff?.overrides, sourceMessageId: message.id })
      else if (relay) { message.handoffDone = false; this.emitMessage(room.id, message, true); this.store.saveSoon(room.id) }
      this.pump(room, memberId)
    })
  }

  stop(roomId: string, memberId?: string): void {
    const room = this.get(roomId)
    const rt = this.runtime(roomId)
    for (const m of room?.members ?? []) {
      if (memberId && m.id !== memberId) continue
      rt.queue.set(m.id, [])
      const job = rt.jobs.get(m.id)
      if (job) job.canceled = true
      const connector = rt.connectors.get(m.id)
      if (connector?.busy) connector.interrupt()
      else if (room && rt.current.get(m.id)?.status === 'streaming') this.finishTurn(room, m.id, { t: 'turn-end', ok: false, stopped: true })
    }
  }

  answer(roomId: string, messageId: string, blockId: string, decision: ApprovalDecision): void {
    const room = this.get(roomId)
    const message = room?.messages.find((m) => m.id === messageId)
    const block = message?.blocks.find((b) => b.id === blockId)
    if (!room || !message || !block || block.kind !== 'approval' || block.status !== 'pending') return
    block.status = ({ allow: 'allowed', always: 'always', deny: 'denied', answer: 'answered' } as const)[decision.kind]
    if (decision.kind === 'answer') block.answers = decision.answers
    this.runtime(roomId).connectors.get(message.author)?.answer(block.requestId, decision)
    this.emitMessage(roomId, message, true)
    this.store.saveSoon(roomId)
  }

  // ---------- retry, edit, undo ----------

  private requireIdle(room: Room): void {
    if (this.runtime(room.id).current.size) throw new Error('Stop the agents that are working first.')
  }

  private previousTurn(room: Room, memberId: string, beforeIndex: number): Message | undefined {
    for (let i = beforeIndex - 1; i >= 0; i--) {
      const m = room.messages[i]
      if (m.author === memberId && m.turn && (m.turn.start || m.turn.end)) return m
    }
    return undefined
  }

  private removeMessages(room: Room, ids: string[]): void {
    if (!ids.length) return
    const set = new Set(ids)
    room.messages = room.messages.filter((m) => !set.has(m.id))
    this.host.emit({ type: 'messages-removed', roomId: room.id, messageIds: ids })
  }

  /** Runs an agent's turn again from the same point, with the same input. */
  async retry(roomId: string, messageId: string): Promise<void> {
    const room = this.get(roomId)
    if (!room) return
    const index = room.messages.findIndex((m) => m.id === messageId)
    const message = room.messages[index]
    if (!message || message.author === 'user') return
    const memberId = message.author
    const member = room.members.find((m) => m.id === memberId)
    if (!member) throw new Error('That agent is no longer in this session.')
    if (this.runtime(roomId).current.has(memberId)) throw new Error('That agent is still working.')
    const later = room.messages.slice(index + 1).filter((m) => m.author === memberId)
    if (later.length) throw new Error('Only the latest reply from an agent can be retried.')
    const c = this.connector(room, member)
    if (typeof c === 'string') throw new Error(c)
    const prev = this.previousTurn(room, memberId, index)
    await c.forkAt(prev?.turn)
    if (!prev) delete room.sessions[memberId]
    this.removeMessages(room, [messageId])
    this.enqueue(room, { memberId, hop: message.hop ?? 0, overrides: message.execution?.delegated ? { model: message.execution.model, effort: message.execution.effort } : undefined, raw: message.prompt ?? { text: 'Please try again.', attachments: [] } })
  }

  /** Replaces one of your messages: later replies are removed and every agent continues from before it. */
  async editMessage(roomId: string, messageId: string, text: string, undoFiles: boolean): Promise<string> {
    const room = this.get(roomId)
    if (!room) return ''
    this.requireIdle(room)
    const index = room.messages.findIndex((m) => m.id === messageId)
    const original = room.messages[index]
    if (!original || original.author !== 'user') return ''
    // Feedback can have been consumed by a reply placed before the feedback itself.
    const consumer = room.messages.findIndex((m) => m.author !== 'user' && m.inputMessageIds?.includes(messageId))
    const rollback = consumer >= 0 ? Math.min(index, consumer) : index
    const later = room.messages.slice(rollback).filter((m, offset) => rollback + offset >= index || m.author !== 'user')
    const notes: string[] = []
    for (const member of room.members) {
      const theirs = later.filter((m) => m.author === member.id)
      if (!theirs.length) continue
      const c = this.connector(room, member)
      if (typeof c === 'string') continue
      if (undoFiles) {
        try {
          for (const m of [...theirs].reverse()) {
            if (m.undone || (!m.diff && !m.snapshot?.after && !m.turn?.start)) continue
            notes.push(`${member.name}: ${await this.undoMessage(room, member, m)}`)
          }
        } catch (err) {
          notes.push(`${member.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const prev = this.previousTurn(room, member.id, rollback)
      await c.forkAt(prev?.turn)
      const consumed = new Set(theirs.flatMap((m) => m.inputMessageIds ?? []))
      for (const m of room.messages) if (consumed.has(m.id)) m.deliveredTo = (m.deliveredTo ?? []).filter((id) => id !== member.id)
      if (!prev) {
        delete room.sessions[member.id]
        for (const m of room.messages.slice(0, rollback)) m.deliveredTo = (m.deliveredTo ?? []).filter((x) => x !== member.id)
      }
    }
    this.removeMessages(room, later.map((m) => m.id))
    this.send(roomId, { text, to: original.to ?? [], attachments: original.attachments ?? [] })
    return notes.join('\n')
  }

  /** Puts files back to how they were before this agent turn. */
  async undoTurn(roomId: string, messageId: string): Promise<string> {
    const room = this.get(roomId)
    const message = room?.messages.find((m) => m.id === messageId)
    const member = room?.members.find((m) => m.id === message?.author)
    if (!room || !message || !member) throw new Error('Message not found')
    if (this.runtime(roomId).current.has(member.id)) throw new Error('Wait for the agent to finish first.')
    const result = await this.undoMessage(room, member, message)
    message.undone = true
    this.emitMessage(roomId, message, true)
    this.store.saveSoon(roomId)
    return result
  }

  private async undoMessage(room: Room, member: Member, message: Message): Promise<string> {
    if (message.sharedChanges) throw new Error('Other agents worked in this folder during this turn. Review the individual files in Changes; undoing this whole turn could remove their work.')
    const folder = member.worktree?.path ?? room.folder
    for (const [otherRoomId, runtime] of this.runtimes) {
      const otherRoom = this.get(otherRoomId)
      if (otherRoom?.members.some((m) => runtime.current.has(m.id) && (m.worktree?.path ?? otherRoom.folder) === folder)) throw new Error('Wait for all agents working in this folder to finish before undoing changes.')
    }
    const snap = message.snapshot
    if (snap?.before && snap.after) {
      if (snap.before === snap.after) return 'This turn did not change any files'
      return restoreTree(member.worktree?.path ?? room.folder, snap.before, snap.after)
    }
    const c = this.connector(room, member)
    if (typeof c === 'string') throw new Error(c)
    if (!c.undoFiles) throw new Error('This agent cannot undo file changes.')
    return c.undoFiles(message.turn ?? {}, message.diff)
  }

  // ---------- per-agent tools ----------

  private connectorFor(roomId: string, memberId: string): AgentConnector {
    const room = this.get(roomId)
    const member = room?.members.find((m) => m.id === memberId)
    if (!room || !member) throw new Error('Agent not found')
    const c = this.connector(room, member)
    if (typeof c === 'string') throw new Error(c)
    return c
  }

  async refreshContext(roomId: string, memberId: string): Promise<void> {
    await this.connectorFor(roomId, memberId).refreshContext()
  }

  mcpList(roomId: string, memberId: string): Promise<McpServer[]> {
    return this.connectorFor(roomId, memberId).mcpList()
  }

  async mcpToggle(roomId: string, memberId: string, name: string, enabled: boolean): Promise<void> {
    const c = this.connectorFor(roomId, memberId)
    if (!c.mcpToggle) throw new Error('Turn MCP servers on or off in Codex config.toml.')
    await c.mcpToggle(name, enabled)
  }

  async mcpReconnect(roomId: string, memberId: string, name: string): Promise<void> {
    await this.connectorFor(roomId, memberId).mcpReconnect?.(name)
  }

  async mergeWorktree(roomId: string, memberId: string): Promise<string> {
    const room = this.get(roomId)
    const member = room?.members.find((m) => m.id === memberId)
    if (!room || !member?.worktree) throw new Error('This agent has no separate copy.')
    if (this.runtime(roomId).current.has(memberId)) throw new Error('Wait for the agent to finish first.')
    return mergeWorktree(room.folder, member.worktree.path, member.worktree.branch, member.name)
  }

  async discardWorktree(roomId: string, memberId: string): Promise<string> {
    const room = this.get(roomId)
    const member = room?.members.find((m) => m.id === memberId)
    if (!room || !member?.worktree) throw new Error('This agent has no separate copy.')
    if (this.runtime(roomId).current.has(memberId)) throw new Error('Wait for the agent to finish first.')
    return resetWorktree(member.worktree.path, member.worktree.base)
  }

  private disposeRuntime(roomId: string): void {
    const rt = this.runtimes.get(roomId)
    if (!rt) return
    for (const c of rt.connectors.values()) c.dispose()
    this.runtimes.delete(roomId)
  }

  busyRooms(): string[] {
    return [...this.runtimes.entries()].filter(([, rt]) => rt.current.size > 0).map(([roomId]) => roomId)
  }

  disposeAll(): void {
    for (const roomId of [...this.runtimes.keys()]) this.disposeRuntime(roomId)
  }
}
