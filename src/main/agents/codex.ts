// Connector for Codex through `codex app-server`, one per agent in a room.
// Streams replies, shows Allow / Deny for commands and file changes, asks your
// questions, and can fork the thread for retry and edit, like the Codex app.

import { EventEmitter } from 'node:events'
import type { ApprovalDecision, CodexMode, McpServer, MemberSettings, Question } from '@shared/types'
import { reverseApply } from '../git'
import type { CodexServer, ThreadHandler } from './codexServer'
import { clip, IMAGE_TYPES, type AgentConnector, type AgentEvent, type TurnInput } from './types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CodexOptions {
  server: CodexServer
  cwd: string
  settings: MemberSettings
  threadId?: string
  /** Only used in team rooms. */
  developerInstructions?: string
  /** Extra folders Codex may write to (the room's shared .collab folder). */
  writableRoots?: string[]
  /** The account's default model, used when the member has none set. */
  defaultModel?: () => string | undefined
}

interface PendingRequest {
  rpcId: number | string
  method: string
  params: Json
}

export function sandboxMode(mode: CodexMode): string {
  return mode === 'read-only' ? 'read-only' : mode === 'full' ? 'danger-full-access' : 'workspace-write'
}

export function approvalPolicy(mode: CodexMode): string {
  return mode === 'full' ? 'never' : mode === 'ask' ? 'untrusted' : 'on-request'
}

/** Codex errors often wrap the API's JSON error: show just its message. */
export function readable(message: string): string {
  try {
    const parsed = JSON.parse(message)
    return parsed?.error?.message ?? parsed?.message ?? message
  } catch {
    return message
  }
}

/** "/bin/bash -lc 'ls -la'" → "ls -la" */
export function unwrapShell(command: string): string {
  const m = /^\/(?:usr\/)?bin\/(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return m ? m[2] : command
}

export class CodexAgent extends EventEmitter implements AgentConnector {
  private threadId?: string
  private loaded = false
  private turnId?: string
  private turnActive = false
  private stopping = false
  private stopTimer?: NodeJS.Timeout
  private lastError = ''
  private forkFrom?: { threadId: string; lastTurnId: string }
  private requests = new Map<string, PendingRequest>()
  private items = new Map<string, Json>()
  private textStarted = new Set<string>()
  private lastUsage?: { inputTokens: number; cachedTokens: number; outputTokens: number; steps: number }
  private startedAt = 0
  private handler: ThreadHandler

  constructor(private opts: CodexOptions) {
    super()
    this.threadId = opts.threadId
    this.handler = {
      notify: (method, params) => this.onNotification(method, params),
      request: (id, method, params) => this.onRequest(id, method, params),
      closed: () => this.onServerClosed()
    }
  }

  get busy(): boolean {
    return this.turnActive
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e)
  }

  private sandboxPolicy(): Json {
    const mode = this.opts.settings.codexMode
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
    if (mode === 'full') return { type: 'dangerFullAccess' }
    return {
      type: 'workspaceWrite',
      writableRoots: this.opts.writableRoots ?? [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  }

  private fallbackModel?: string

  private model(selected = this.opts.settings.model): string | null {
    return selected || this.opts.defaultModel?.() || this.fallbackModel || null
  }

  /** Makes sure a model is chosen even before the account's model list has loaded. */
  private async resolveModel(): Promise<void> {
    if (this.model()) return
    try {
      const r = await this.opts.server.call('model/list', {})
      const list: Json[] = r.data ?? []
      this.fallbackModel = (list.find((m) => m.isDefault && !m.hidden) ?? list.find((m) => !m.hidden))?.id
    } catch {
      // Let Codex use its own config.
    }
  }

  private threadParams(): Json {
    const s = this.opts.settings
    return {
      cwd: this.opts.cwd,
      model: this.model(),
      approvalPolicy: approvalPolicy(s.codexMode),
      sandbox: sandboxMode(s.codexMode),
      developerInstructions: this.opts.developerInstructions ?? null
    }
  }

  private setThread(id: string): void {
    if (this.threadId && this.threadId !== id) this.opts.server.unsubscribe(this.threadId, this.handler)
    this.threadId = id
    this.opts.server.subscribe(id, this.handler)
    this.emitEvent({ t: 'session', id })
  }

  private async ensureThread(): Promise<string> {
    const server = this.opts.server
    await server.start()
    await this.resolveModel()
    if (this.forkFrom) {
      const from = this.forkFrom
      this.forkFrom = undefined
      const r = await server.call('thread/fork', { threadId: from.threadId, lastTurnId: from.lastTurnId, ...this.threadParams() })
      this.setThread(r.thread.id)
      this.loaded = true
      return r.thread.id
    }
    if (this.threadId && this.loaded && server.running) return this.threadId
    if (this.threadId) {
      try {
        server.subscribe(this.threadId, this.handler)
        await server.call('thread/resume', { threadId: this.threadId, ...this.threadParams(), excludeTurns: true })
        this.loaded = true
        return this.threadId
      } catch {
        // The saved thread is gone (for example on another computer).
        server.unsubscribe(this.threadId, this.handler)
        this.threadId = undefined
        this.emitEvent({ t: 'session-invalid' })
        throw new Error('__session_invalid__')
      }
    }
    const r = await server.call('thread/start', this.threadParams())
    this.setThread(r.thread.id)
    this.loaded = true
    return r.thread.id
  }

  send(input: TurnInput): void {
    this.turnActive = true
    this.stopping = false
    this.lastError = ''
    this.turnId = undefined
    this.lastUsage = undefined
    this.textStarted.clear()
    this.startedAt = Date.now()
    this.emitEvent({ t: 'status', status: 'thinking' })
    void (async () => {
      try {
        const threadId = await this.ensureThread()
        const s = this.opts.settings
        const items: Json[] = [{ type: 'text', text: input.text, text_elements: [] }]
        for (const img of input.images) if (IMAGE_TYPES.has(img.mime)) items.push({ type: 'localImage', path: img.path })
        const r = await this.opts.server.call('turn/start', {
          threadId,
          input: items,
          model: this.model(input.overrides?.model),
          effort: (input.overrides?.effort ?? s.effort) || null,
          approvalPolicy: approvalPolicy(s.codexMode),
          sandboxPolicy: this.sandboxPolicy()
        })
        if (r.turn?.id && !this.turnId) {
          this.turnId = r.turn.id
          this.emitEvent({ t: 'turn-ref', start: r.turn.id })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message === '__session_invalid__') {
          this.turnActive = false
          return
        }
        this.finish({ t: 'turn-end', ok: false, error: readable(message) })
      }
    })()
  }

  // The Codex app's way of typing while it works: turn/steer adds the message to the
  // running turn. Model, effort and access mode are per turn and apply from the next one.
  async steer(input: TurnInput): Promise<boolean> {
    if (!this.turnActive || this.stopping || !this.threadId || !this.turnId) return false
    const items: Json[] = [{ type: 'text', text: input.text, text_elements: [] }]
    for (const img of input.images) if (IMAGE_TYPES.has(img.mime)) items.push({ type: 'localImage', path: img.path })
    try {
      await this.opts.server.call('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: items })
      return true
    } catch {
      return false
    }
  }

  /** /review runs Codex's own code review; /compact summarizes the thread. */
  command(name: string, args: string): boolean {
    if (name !== 'review' && name !== 'compact') return false
    this.turnActive = true
    this.stopping = false
    this.lastError = ''
    this.turnId = undefined
    this.textStarted.clear()
    this.startedAt = Date.now()
    this.emitEvent({ t: 'status', status: 'working', detail: name })
    void (async () => {
      try {
        const threadId = await this.ensureThread()
        if (name === 'compact') {
          await this.opts.server.call('thread/compact/start', { threadId })
          const id = `codex-compact-${Date.now()}`
          this.emitEvent({ t: 'tool-start', id, name: 'Compact', input: {} })
          this.emitEvent({ t: 'tool-end', id, output: 'Codex is compacting the conversation' })
          this.finish({ t: 'turn-end', ok: true })
          return
        }
        const target = args.trim() ? { type: 'custom', instructions: args.trim() } : { type: 'uncommittedChanges' }
        const r = await this.opts.server.call('review/start', { threadId, target, delivery: 'inline' })
        if (r.turn?.id && !this.turnId) {
          this.turnId = r.turn.id
          this.emitEvent({ t: 'turn-ref', start: r.turn.id })
        }
      } catch (err) {
        if (err instanceof Error && err.message === '__session_invalid__') {
          this.turnActive = false
          return
        }
        this.finish({ t: 'turn-end', ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return true
  }

  interrupt(): void {
    if (!this.turnActive) return
    this.stopping = true
    if (this.threadId && this.turnId) {
      this.opts.server.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    }
    clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      if (this.turnActive) this.finish({ t: 'turn-end', ok: false, stopped: true })
    }, 8000)
  }

  answer(requestId: string, decision: ApprovalDecision): void {
    const req = this.requests.get(requestId)
    if (!req) return
    this.requests.delete(requestId)
    const server = this.opts.server
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const map = { allow: 'accept', always: 'acceptForSession', deny: 'decline', answer: 'accept' } as const
        server.respond(req.rpcId, { decision: map[decision.kind] })
        break
      }
      case 'item/permissions/requestApproval': {
        const requested = req.params.permissions ?? {}
        const granted: Json = {}
        if (requested.network) granted.network = requested.network
        if (requested.fileSystem) granted.fileSystem = requested.fileSystem
        if (decision.kind === 'deny') server.respond(req.rpcId, { permissions: {}, scope: 'turn' })
        else server.respond(req.rpcId, { permissions: granted, scope: decision.kind === 'always' ? 'session' : 'turn' })
        break
      }
      case 'item/tool/requestUserInput': {
        const answers: Json = {}
        if (decision.kind === 'answer') {
          for (const [id, value] of Object.entries(decision.answers)) answers[id] = { answers: value ? value.split(', ') : [] }
        }
        server.respond(req.rpcId, { answers })
        break
      }
      default:
        server.respondError(req.rpcId, 'Declined')
    }
    if (this.requests.size === 0 && this.turnActive) this.emitEvent({ t: 'status', status: 'working' })
  }

  update(settings: MemberSettings, systemPrompt?: string): void {
    // Model, effort and mode are sent with every turn, so they apply right away.
    this.opts = { ...this.opts, settings, developerInstructions: systemPrompt }
  }

  async forkAt(ref: { start?: string } | undefined): Promise<void> {
    if (this.turnActive) throw new Error('Wait for GPT to finish first.')
    if (this.threadId) this.opts.server.unsubscribe(this.threadId, this.handler)
    this.loaded = false
    if (!ref?.start || !this.threadId) {
      this.threadId = undefined
      return
    }
    this.forkFrom = { threadId: this.threadId, lastTurnId: ref.start }
  }

  async undoFiles(_ref: { start?: string }, diff?: string): Promise<string> {
    if (!diff?.trim()) throw new Error('This turn did not change any files.')
    return reverseApply(this.opts.cwd, diff)
  }

  async refreshContext(): Promise<void> {
    // Codex pushes token usage after every turn (thread/tokenUsage/updated).
  }

  async mcpList(): Promise<McpServer[]> {
    const r = await this.opts.server.request('mcpServerStatus/list', { threadId: this.threadId ?? null })
    return (r.data ?? []).map((s: Json) => ({
      name: s.name,
      status: s.runtimeStatus ?? (s.authStatus === 'notLoggedIn' ? 'authenticationRequired' : 'configured'),
      tools: s.tools ? Object.keys(s.tools).length : undefined,
      error: s.toolsError ?? undefined
    }))
  }

  async mcpReconnect(): Promise<void> {
    await this.opts.server.request('config/mcpServer/reload', {})
  }

  dispose(): void {
    if (this.turnActive) this.interrupt()
    if (this.threadId) this.opts.server.unsubscribe(this.threadId, this.handler)
    this.removeAllListeners()
  }

  // ---------- events from the server ----------

  private finish(e: Extract<AgentEvent, { t: 'turn-end' }>): void {
    if (!this.turnActive) return
    this.turnActive = false
    clearTimeout(this.stopTimer)
    if (this.requests.size) {
      for (const [, req] of this.requests) this.opts.server.respondError(req.rpcId, 'Turn ended')
      this.requests.clear()
      this.emitEvent({ t: 'approvals-expired' })
    }
    this.emitEvent(e)
  }

  private onServerClosed(): void {
    this.loaded = false
    if (this.turnActive) {
      this.finish({ t: 'turn-end', ok: false, stopped: this.stopping, error: this.stopping ? undefined : 'Codex stopped unexpectedly.' })
    }
  }

  private onNotification(method: string, p: Json): void {
    switch (method) {
      case 'turn/started':
        if (p.turn?.id && !this.turnId) {
          this.turnId = p.turn.id
          this.emitEvent({ t: 'turn-ref', start: p.turn.id })
        }
        return
      case 'item/started':
        return this.onItem(p.item ?? {}, false)
      case 'item/completed':
        return this.onItem(p.item ?? {}, true)
      case 'item/agentMessage/delta': {
        const key = `codex-${p.itemId}`
        if (!this.textStarted.has(key)) {
          this.textStarted.add(key)
          this.emitEvent({ t: 'block-start', key, kind: 'text' })
        }
        this.emitEvent({ t: 'delta', key, text: p.delta ?? '' })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const key = `codex-${p.itemId}`
        if (!this.textStarted.has(key)) {
          this.textStarted.add(key)
          this.emitEvent({ t: 'block-start', key, kind: 'thinking' })
        }
        this.emitEvent({ t: 'delta', key, text: p.delta ?? '' })
        return
      }
      case 'item/commandExecution/outputDelta':
        this.emitEvent({ t: 'tool-output', id: `codex-${p.itemId}`, text: p.delta ?? '' })
        return
      case 'turn/plan/updated': {
        const id = `codex-plan-${p.turnId}`
        const items = (p.plan ?? []).map((s: Json) => ({ text: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status }))
        this.emitEvent({ t: 'tool-input', id, name: 'Plan', input: { items, explanation: p.explanation } })
        return
      }
      case 'turn/diff/updated':
        if (typeof p.diff === 'string') this.emitEvent({ t: 'diff', diff: p.diff })
        return
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {}
        const last = u.last ?? {}
        // One update per model call: add them up for the turn, like Claude's totals.
        if (this.turnActive && (!p.turnId || !this.turnId || p.turnId === this.turnId)) {
          const sum = this.lastUsage ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, steps: 0 }
          this.lastUsage = {
            inputTokens: sum.inputTokens + (last.inputTokens ?? 0),
            cachedTokens: sum.cachedTokens + (last.cachedInputTokens ?? 0),
            // Codex's outputTokens already includes reasoning (total = input + output).
            outputTokens: sum.outputTokens + (last.outputTokens ?? 0),
            steps: sum.steps + 1
          }
        }
        if (u.modelContextWindow) {
          const used = last.totalTokens ?? (last.inputTokens ?? 0) + (last.outputTokens ?? 0)
          this.emitEvent({ t: 'context', context: { used, max: u.modelContextWindow, percent: Math.round((used / u.modelContextWindow) * 100) } })
        }
        return
      }
      case 'turn/completed': {
        const turn = p.turn ?? {}
        this.emitEvent({ t: 'tool-end', id: `codex-plan-${turn.id}` })
        const status = turn.status
        this.finish({
          t: 'turn-end',
          ok: status === 'completed',
          stopped: status === 'interrupted' || this.stopping,
          error: status === 'failed' ? readable(turn.error?.message || this.lastError || 'Codex turn failed') : undefined,
          usage: { ...this.lastUsage, durationMs: turn.durationMs ?? Date.now() - this.startedAt }
        })
        return
      }
      case 'error':
        if (p.willRetry) this.emitEvent({ t: 'status', status: 'thinking', detail: 'retrying' })
        else this.lastError = p.error?.message ?? 'Codex error'
        return
      case 'thread/compacted': {
        const id = `codex-compact-${Date.now()}`
        this.emitEvent({ t: 'tool-start', id, name: 'Compact', input: {} })
        this.emitEvent({ t: 'tool-end', id, output: 'Conversation compacted' })
        return
      }
    }
  }

  private startTool(id: string, name: string, input: unknown, first: boolean): void {
    if (first) {
      this.emitEvent({ t: 'tool-start', id, name, input })
      this.emitEvent({ t: 'status', status: 'working', detail: name })
    } else this.emitEvent({ t: 'tool-input', id, name, input })
  }

  private onItem(item: Json, done: boolean): void {
    const id = `codex-${item.id}`
    const first = !done
    this.items.set(String(item.id), item)
    switch (item.type) {
      case 'agentMessage':
        if (done && item.text) this.emitEvent({ t: 'block-set', key: id, kind: 'text', text: item.text })
        return
      case 'plan':
        if (done && item.text) this.emitEvent({ t: 'block-set', key: id, kind: 'text', text: item.text })
        return
      case 'reasoning': {
        const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : (item.content ?? []))].join('\n\n')
        if (done && text) this.emitEvent({ t: 'block-set', key: id, kind: 'thinking', text })
        return
      }
      case 'commandExecution':
        this.startTool(id, 'Shell', { command: unwrapShell(String(item.command ?? '')), cwd: item.cwd }, first)
        if (done) {
          const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0
          this.emitEvent({ t: 'tool-end', id, output: clip(String(item.aggregatedOutput ?? '')), isError: failed })
        }
        return
      case 'fileChange': {
        const changes = (item.changes ?? []).map((c: Json) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff }))
        this.startTool(id, 'Edit files', { changes }, first)
        if (done) {
          const failed = item.status === 'failed' || item.status === 'declined'
          this.emitEvent({ t: 'tool-end', id, output: changes.map((c: Json) => `${c.kind}: ${c.path}`).join('\n'), isError: failed })
        }
        return
      }
      case 'mcpToolCall':
        this.startTool(id, `${item.server}: ${item.tool}`, item.arguments ?? {}, first)
        if (done) {
          const content = item.result?.content ?? []
          const out = item.error
            ? String(item.error.message ?? JSON.stringify(item.error))
            : content.map((c: Json) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
          this.emitEvent({ t: 'tool-end', id, output: clip(out), isError: !!item.error || item.status === 'failed' })
        }
        return
      case 'dynamicToolCall':
        this.startTool(id, String(item.tool ?? 'tool'), item.arguments ?? {}, first)
        if (done) this.emitEvent({ t: 'tool-end', id, isError: item.success === false })
        return
      case 'webSearch':
        this.startTool(id, 'Web search', { query: item.query ?? item.action?.query }, first)
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'imageView':
        this.startTool(id, 'View image', { path: item.path }, first)
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'imageGeneration':
        this.startTool(id, 'Generate image', { prompt: item.revisedPrompt ?? item.prompt }, first)
        if (done) this.emitEvent({ t: 'tool-end', id, output: item.savedPath ?? '' })
        return
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        this.startTool(id, 'Agent', { description: item.prompt ?? item.agentPath ?? item.kind }, first)
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        this.startTool(id, 'Review', { description: item.review }, first)
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'contextCompaction':
        this.startTool(id, 'Compact', {}, first)
        if (done) this.emitEvent({ t: 'tool-end', id, output: 'Conversation compacted' })
        return
    }
  }

  private onRequest(rpcId: number | string, method: string, p: Json): void {
    const requestId = `codex-req-${rpcId}`
    const item = this.items.get(String(p.itemId))
    let toolName = ''
    let input: Json = {}
    let questions: Question[] | undefined
    let canAlways = true
    switch (method) {
      case 'item/commandExecution/requestApproval':
        toolName = 'command'
        input = { command: unwrapShell(String(p.command ?? item?.command ?? '')), cwd: p.cwd, reason: p.reason }
        break
      case 'item/fileChange/requestApproval':
        toolName = 'file change'
        input = {
          changes: (item?.changes ?? []).map((c: Json) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff })),
          reason: p.reason
        }
        break
      case 'item/permissions/requestApproval':
        toolName = 'permissions'
        input = { permissions: p.permissions, reason: p.reason }
        break
      case 'item/tool/requestUserInput':
        toolName = 'question'
        canAlways = false
        questions = (p.questions ?? []).map((q: Json) => ({
          id: String(q.id),
          question: String(q.question),
          header: q.header,
          options: (q.options ?? []).map((o: Json) => ({ label: String(o.label), description: o.description }))
        }))
        break
      default:
        this.opts.server.respondError(rpcId, `Interface does not support ${method} yet`)
        return
    }
    this.requests.set(requestId, { rpcId, method, params: p })
    this.emitEvent({
      t: 'approval',
      requestId,
      toolName,
      toolUseId: item ? `codex-${item.id}` : undefined,
      input,
      description: typeof p.reason === 'string' ? p.reason : undefined,
      canAlways,
      questions
    })
    this.emitEvent({ t: 'status', status: 'waiting', detail: toolName })
  }
}
