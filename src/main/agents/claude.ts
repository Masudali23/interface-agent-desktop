// Connector for Claude Code, one per agent in a room.
//
// It runs the official `claude` program with streaming JSON in and out, and talks to it
// with the same control protocol Claude desktop uses: approvals come in as
// `can_use_tool` requests, and models, permission modes, context, MCP servers, usage and
// file rewind are all asked for with control requests. Nothing about the model's
// own system prompt or tools is replaced.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ApprovalDecision, McpServer, MemberSettings, MessageUsage, ModelOption, Question, SlashCommand } from '@shared/types'
import { ClaudeProcess } from './claudeProcess'
import { claudeLimits, claudeRateEvent } from './usage'
import { clip, IMAGE_TYPES, type AgentConnector, type AgentEvent, type TurnInput } from './types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ClaudeOptions {
  binary: string
  cwd: string
  env: NodeJS.ProcessEnv
  settings: MemberSettings
  sessionId?: string
  /** Only used in team rooms; solo rooms run exactly like Claude Code. */
  systemPrompt?: string
  addDirs?: string[]
}

interface PendingApproval {
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: Json) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c)))
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

/** Effort levels Claude Code can switch to mid-session (its effortLevel setting). */
const LIVE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

export function addUsage(a: MessageUsage | undefined, b: MessageUsage): MessageUsage {
  if (!a) return b
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0))
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    cachedTokens: sum(a.cachedTokens, b.cachedTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    steps: sum(a.steps, b.steps),
    durationMs: sum(a.durationMs, b.durationMs)
  }
}

export function claudeModels(list: Json[] | undefined): ModelOption[] {
  return (list ?? []).map((m) => ({
    id: m.value === 'default' ? '' : String(m.value),
    label: String(m.displayName ?? m.value),
    description: m.description,
    efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
    isDefault: m.value === 'default'
  }))
}

export function claudeCommands(list: Json[] | undefined): SlashCommand[] {
  return (list ?? []).map((c) => ({ name: String(c.name), description: c.description, argumentHint: c.argumentHint || undefined }))
}

export class ClaudeAgent extends EventEmitter implements AgentConnector {
  private proc?: ClaudeProcess
  private turnActive = false
  private stopping = false
  private stopTimer?: NodeJS.Timeout
  private sawInit = false
  private restartAfterTurn = false
  /** Settings of the running process, which may differ from the user's defaults. */
  private effectiveSettings?: MemberSettings
  private streamedMessages = new Set<string>()
  private currentMessage = ''
  private blockKeys = new Map<number, string>()
  private approvals = new Map<string, PendingApproval>()
  private turnStartSeen = false
  private resumeAt?: string
  private forkNext = false
  private launchedBypass = false
  /** Messages written into the running turn that Claude Code has not picked up yet. */
  private unreadSteers = 0
  /** Usage of earlier results when one turn spans several (a late steer starts another). */
  private carried?: MessageUsage
  private carryTimer?: NodeJS.Timeout

  constructor(private opts: ClaudeOptions) {
    super()
  }

  get busy(): boolean {
    return this.turnActive
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e)
  }

  // ---------- process ----------

  private args(s: MemberSettings): string[] {
    const args = [
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
      '--permission-mode', s.permissionMode
    ]
    if (this.opts.systemPrompt) args.push('--append-system-prompt', this.opts.systemPrompt)
    if (s.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
    if (s.model) args.push('--model', s.model)
    if (s.effort) args.push('--effort', s.effort)
    for (const dir of this.opts.addDirs ?? []) args.push('--add-dir', dir)
    if (this.opts.sessionId) {
      args.push('--resume', this.opts.sessionId)
      if (this.resumeAt) args.push('--resume-session-at', this.resumeAt)
      if (this.forkNext) args.push('--fork-session')
    }
    return args
  }

  private ensureProcess(settings = this.opts.settings): ClaudeProcess {
    if (this.proc?.alive) return this.proc
    this.sawInit = false
    this.effectiveSettings = { ...settings }
    this.launchedBypass = settings.permissionMode === 'bypassPermissions'
    const proc = new ClaudeProcess({
      binary: this.opts.binary,
      cwd: this.opts.cwd,
      // File checkpoints make "Undo" (rewind_files) possible, as in Claude desktop.
      env: { ...this.opts.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
      args: this.args(settings)
    })
    this.resumeAt = undefined
    this.forkNext = false
    this.proc = proc
    // A replaced process (after a fork or settings change) may still print while it
    // shuts down; only the current one may affect turns.
    proc.on('message', (ev: Json) => this.proc === proc && this.onMessage(ev))
    proc.on('control', (ev: Json) => this.proc === proc && this.onControl(proc, ev))
    proc.on('exit', (code: number | null) => this.onExit(proc, code))
    proc
      .request({ subtype: 'initialize' }, 30000)
      .then((r) => {
        this.emitEvent({
          t: 'meta',
          meta: { models: claudeModels(r.models), commands: claudeCommands(r.commands) },
          account: r.account
            ? { loggedIn: true, email: r.account.email, plan: r.account.subscriptionType, org: r.account.organization }
            : undefined
        })
      })
      .catch(() => {})
    return proc
  }

  private stopProcess(): void {
    const proc = this.proc
    this.proc = undefined
    this.effectiveSettings = undefined
    proc?.end()
  }

  dispose(): void {
    clearTimeout(this.carryTimer)
    this.removeAllListeners()
    this.stopProcess()
  }

  // ---------- turns ----------

  private content(input: TurnInput): unknown {
    const images = input.images.filter((a) => IMAGE_TYPES.has(a.mime) && a.size < 5 * 1024 * 1024)
    if (!images.length) return input.text
    const blocks: unknown[] = [{ type: 'text', text: input.text }]
    for (const img of images) {
      try {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: readFileSync(img.path).toString('base64') } })
      } catch {
        // Unreadable attachment: its path is still in the text.
      }
    }
    return blocks
  }

  send(input: TurnInput): void {
    const content = this.content(input)
    const saved = this.opts.settings
    const settings = {
      ...saved,
      model: input.overrides?.model ?? saved.model,
      effort: input.overrides?.effort ?? saved.effort
    }
    const overridden = settings.model !== saved.model || settings.effort !== saved.effort
    // Launch-only effort values need a new process. Resume the same conversation,
    // then retire this process when the delegated turn ends to restore current prefs.
    if (overridden) this.stopProcess()
    this.restartAfterTurn = overridden
    const proc = this.ensureProcess(settings)
    this.turnActive = true
    this.stopping = false
    this.turnStartSeen = false
    this.unreadSteers = 0
    this.carried = undefined
    this.blockKeys.clear()
    proc.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
    this.emitEvent({ t: 'status', status: 'thinking' })
  }

  // Claude Code reads a message written mid-turn at its next step, as when typing
  // into it while it works; the echo (--replay-user-messages) shows when it did.
  async steer(input: TurnInput): Promise<boolean> {
    if (!this.turnActive || this.stopping || !this.proc?.alive) return false
    this.unreadSteers++
    this.proc.write({ type: 'user', message: { role: 'user', content: this.content(input) }, parent_tool_use_id: null })
    return true
  }

  interrupt(): void {
    if (!this.turnActive || !this.proc) return
    this.stopping = true
    this.proc.request({ subtype: 'interrupt' }).catch(() => {})
    clearTimeout(this.stopTimer)
    const proc = this.proc
    this.stopTimer = setTimeout(() => {
      if (this.turnActive) proc.kill()
    }, 5000)
  }

  answer(requestId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(requestId)
    if (!pending || !this.proc) return
    this.approvals.delete(requestId)
    let response: Json
    switch (decision.kind) {
      case 'allow':
        response = { behavior: 'allow', updatedInput: pending.input }
        break
      case 'always':
        response = { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions ?? [] }
        break
      case 'answer':
        response = { behavior: 'allow', updatedInput: { ...pending.input, answers: decision.answers } }
        break
      default:
        response = { behavior: 'deny', message: decision.message || 'The user denied this action.' }
    }
    this.proc.respond(requestId, response)
    if (this.approvals.size === 0) this.emitEvent({ t: 'status', status: 'working' })
  }

  update(settings: MemberSettings, systemPrompt?: string): void {
    const prev = this.effectiveSettings ?? this.opts.settings
    const prevPrompt = this.opts.systemPrompt
    this.opts = { ...this.opts, settings, systemPrompt }
    const proc = this.proc
    if (!proc?.alive) return
    this.effectiveSettings = { ...settings }
    // Live changes, exactly like switching in Claude desktop: they apply to the turn
    // that is running from its next step.
    if (prev.model !== settings.model) proc.request({ subtype: 'set_model', model: settings.model || null }).catch(() => {})
    if (prev.permissionMode !== settings.permissionMode && (settings.permissionMode !== 'bypassPermissions' || this.launchedBypass)) {
      proc.request({ subtype: 'set_permission_mode', mode: settings.permissionMode }).catch(() => {})
    }
    if (prev.effort !== settings.effort && LIVE_EFFORTS.has(settings.effort)) {
      proc.request({ subtype: 'apply_flag_settings', settings: { effortLevel: settings.effort } }).catch(() => {})
    }
    // Restarting (resuming the same session) makes --effort and the rest stick for later
    // turns too. Bypass needs a launch flag; until then the room allows every request.
    const needsRestart =
      prev.effort !== settings.effort ||
      prevPrompt !== systemPrompt ||
      (settings.permissionMode === 'bypassPermissions' && !this.launchedBypass)
    if (needsRestart) {
      if (this.turnActive) this.restartAfterTurn = true
      else this.stopProcess()
    }
  }

  async forkAt(ref: { start?: string; end?: string } | undefined): Promise<void> {
    if (this.turnActive) throw new Error('Wait for Claude to finish first.')
    this.stopProcess()
    if (!ref?.end) {
      this.opts.sessionId = undefined
      return
    }
    this.resumeAt = ref.end
    this.forkNext = true
  }

  async undoFiles(ref: { start?: string }): Promise<string> {
    if (!ref.start) throw new Error('This turn has no checkpoint to go back to.')
    if (this.turnActive) throw new Error('Wait for Claude to finish first.')
    const proc = this.ensureProcess()
    const r = await proc.request({ subtype: 'rewind_files', user_message_id: ref.start, dry_run: false }, 60000)
    if (r.canRewind === false || r.error) throw new Error(String(r.error ?? 'Claude Code could not rewind these files.'))
    const files = Array.isArray(r.filesChanged) ? r.filesChanged.length : r.filesChanged
    return files ? `Put back ${files} file${files === 1 ? '' : 's'}` : 'Files put back'
  }

  async refreshContext(): Promise<void> {
    if (!this.proc?.alive || this.turnActive) return
    try {
      const r = await this.proc.request({ subtype: 'get_context_usage' })
      if (r.maxTokens) {
        this.emitEvent({ t: 'context', context: { used: r.totalTokens ?? 0, max: r.maxTokens, percent: r.percentage ?? Math.round(((r.totalTokens ?? 0) / r.maxTokens) * 100) } })
      }
    } catch {
      // Older Claude Code.
    }
  }

  async refreshUsage(): Promise<void> {
    if (!this.proc?.alive) return
    try {
      const r = await this.proc.request({ subtype: 'get_usage' })
      const { limits, notes } = claudeLimits(r)
      if (limits.length) this.emitEvent({ t: 'account', info: { limits, notes, checkedAt: Date.now() } })
    } catch {
      // Not available.
    }
  }

  async mcpList(): Promise<McpServer[]> {
    const proc = this.ensureProcess()
    const r = await proc.request({ subtype: 'mcp_status' }, 30000)
    return (r.mcpServers ?? []).map((s: Json) => ({
      name: s.name,
      status: s.status,
      tools: Array.isArray(s.tools) ? s.tools.length : undefined,
      scope: s.scope,
      error: s.error
    }))
  }

  async mcpToggle(name: string, enabled: boolean): Promise<void> {
    await this.ensureProcess().request({ subtype: 'mcp_toggle', serverName: name, enabled }, 30000)
  }

  async mcpReconnect(name: string): Promise<void> {
    await this.ensureProcess().request({ subtype: 'mcp_reconnect', serverName: name }, 60000)
  }

  // ---------- output ----------

  private onExit(proc: ClaudeProcess, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = undefined
    this.effectiveSettings = undefined
    this.restartAfterTurn = false
    clearTimeout(this.stopTimer)
    if (this.approvals.size) {
      this.approvals.clear()
      this.emitEvent({ t: 'approvals-expired' })
    }
    if (!this.sawInit && this.turnActive && /no conversation found|session.*not found|not found.*session/i.test(proc.stderrTail)) {
      this.opts.sessionId = undefined
      this.turnActive = false
      this.emitEvent({ t: 'session-invalid' })
      return
    }
    if (this.turnActive) {
      this.turnActive = false
      const detail = proc.stderrTail.trim().split('\n').slice(-6).join('\n')
      this.emitEvent({
        t: 'turn-end',
        ok: false,
        stopped: this.stopping,
        error: this.stopping ? undefined : detail || `Claude Code exited (code ${code ?? 'unknown'}).`
      })
    }
  }

  private onMessage(ev: Json): void {
    clearTimeout(this.carryTimer)
    switch (ev.type) {
      case 'system':
        return this.onSystem(ev)
      case 'stream_event':
        if (!ev.parent_tool_use_id) this.onStream(ev.event)
        return
      case 'assistant':
        if (!ev.parent_tool_use_id) this.onAssistant(ev)
        return
      case 'user':
        if (!ev.parent_tool_use_id) this.onUser(ev)
        return
      case 'rate_limit_event': {
        const limits = claudeRateEvent(ev.rate_limit_info)
        if (limits.length) this.emitEvent({ t: 'account', info: { limits } })
        return
      }
      case 'result':
        return this.onResult(ev)
    }
  }

  private onSystem(ev: Json): void {
    switch (ev.subtype) {
      case 'init':
        this.sawInit = true
        if (ev.session_id) {
          this.opts.sessionId = ev.session_id
          this.emitEvent({ t: 'session', id: ev.session_id })
        }
        return
      case 'status':
        if (ev.status === 'requesting') this.emitEvent({ t: 'status', status: 'thinking' })
        if (ev.status === 'compacting') this.emitEvent({ t: 'status', status: 'working', detail: 'compacting' })
        return
      case 'compact_boundary': {
        const id = `compact-${randomUUID()}`
        this.emitEvent({ t: 'tool-start', id, name: 'Compact', input: { trigger: ev.compact_metadata?.trigger } })
        this.emitEvent({ t: 'tool-end', id, output: 'Conversation compacted' })
        return
      }
      case 'api_retry':
        this.emitEvent({ t: 'status', status: 'thinking', detail: 'retrying' })
        return
    }
  }

  private onStream(e: Json): void {
    if (!e) return
    switch (e.type) {
      case 'message_start':
        this.currentMessage = e.message?.id ?? randomUUID()
        this.streamedMessages.add(this.currentMessage)
        this.blockKeys.clear()
        return
      case 'content_block_start': {
        const block = e.content_block ?? {}
        const key = `${this.currentMessage}:${e.index}`
        if (block.type === 'text' || block.type === 'thinking') {
          this.blockKeys.set(e.index, key)
          this.emitEvent({ t: 'block-start', key, kind: block.type })
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          this.emitEvent({ t: 'tool-start', id: block.id, name: block.name, input: {} })
          this.emitEvent({ t: 'status', status: 'working', detail: block.name })
        }
        return
      }
      case 'content_block_delta': {
        const key = this.blockKeys.get(e.index)
        if (!key) return
        const d = e.delta ?? {}
        if (d.type === 'text_delta' && d.text) this.emitEvent({ t: 'delta', key, text: d.text })
        else if (d.type === 'thinking_delta' && d.thinking) this.emitEvent({ t: 'delta', key, text: d.thinking })
        return
      }
    }
  }

  private onAssistant(ev: Json): void {
    const message = ev.message
    if (!message) return
    if (ev.uuid) this.emitEvent({ t: 'turn-ref', end: ev.uuid })
    const streamed = this.streamedMessages.has(message.id)
    const content: Json[] = Array.isArray(message.content) ? message.content : []
    content.forEach((c, i) => {
      if (c.type === 'tool_use' || c.type === 'server_tool_use') {
        this.emitEvent({ t: 'tool-input', id: c.id, name: c.name, input: c.input })
      } else if (!streamed && (c.type === 'text' || c.type === 'thinking')) {
        const text = c.type === 'text' ? c.text : c.thinking
        if (text) this.emitEvent({ t: 'block-set', key: `${message.id}:${i}`, kind: c.type, text })
      }
    })
  }

  private onUser(ev: Json): void {
    const content = ev.message?.content
    const results = Array.isArray(content) ? content.filter((c: Json) => c?.type === 'tool_result') : []
    if (results.length) {
      for (const c of results) {
        this.emitEvent({ t: 'tool-end', id: c.tool_use_id, output: clip(toolOutput(c.content)), isError: !!c.is_error })
      }
      return
    }
    // The echo of the message we sent (--replay-user-messages): its uuid is the rewind point.
    if (this.turnActive && !this.turnStartSeen && ev.uuid && !ev.isSynthetic) {
      this.turnStartSeen = true
      this.emitEvent({ t: 'turn-ref', start: ev.uuid })
    } else if (this.turnActive && ev.isReplay && !ev.isSynthetic && this.unreadSteers > 0) {
      this.unreadSteers--
    }
  }

  private onControl(proc: ClaudeProcess, ev: Json): void {
    const req = ev.request ?? {}
    if (req.subtype !== 'can_use_tool') {
      proc.respondError(ev.request_id, `Unsupported request: ${req.subtype}`)
      return
    }
    const input = (req.input ?? {}) as Record<string, unknown>
    this.approvals.set(ev.request_id, { toolName: req.tool_name, input, suggestions: req.permission_suggestions })
    let questions: Question[] | undefined
    if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
      questions = (input.questions as Json[]).map((q) => ({
        id: String(q.question),
        question: String(q.question),
        header: q.header,
        multiSelect: !!q.multiSelect,
        options: Array.isArray(q.options) ? q.options.map((o: Json) => ({ label: String(o.label), description: o.description })) : []
      }))
    }
    this.emitEvent({
      t: 'approval',
      requestId: ev.request_id,
      toolName: req.tool_name,
      toolUseId: req.tool_use_id,
      input,
      description: req.description,
      canAlways: Array.isArray(req.permission_suggestions) && req.permission_suggestions.length > 0,
      questions
    })
    this.emitEvent({ t: 'status', status: 'waiting', detail: req.tool_name })
  }

  private onResult(ev: Json): void {
    if (!this.turnActive) return
    const u = ev.usage ?? {}
    const failed = ev.is_error || (ev.subtype && ev.subtype !== 'success')
    const usage: MessageUsage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      cachedTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens,
      steps: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
      durationMs: ev.duration_ms
    }
    const total = addUsage(this.carried, usage)
    // A message that arrived just as Claude finished answering starts one more turn in
    // Claude Code: keep this reply open and continue it there.
    if (this.unreadSteers > 0 && !failed && !this.stopping) {
      this.carried = total
      // Should Claude Code never pick the message up, end the reply anyway.
      this.carryTimer = setTimeout(() => {
        this.unreadSteers = 0
        this.onResult({ ...ev, usage: {}, num_turns: undefined, duration_ms: undefined })
      }, 30000)
      return
    }
    this.turnActive = false
    this.unreadSteers = 0
    this.carried = undefined
    clearTimeout(this.stopTimer)
    const stopped = this.stopping
    this.stopping = false
    const restart = this.restartAfterTurn
    this.restartAfterTurn = false
    // Listeners may synchronously send the next turn when they receive turn-end.
    // Retire overridden settings first so that turn resumes with the latest defaults.
    if (restart) this.stopProcess()
    this.emitEvent({
      t: 'turn-end',
      ok: !failed,
      stopped,
      error: failed && !stopped ? String(ev.result || (ev.errors ?? []).join('\n') || ev.subtype) : undefined,
      // Totals for the whole turn: every tool step re-sends the conversation, which is
      // mostly served from the prompt cache, so cached reads are kept apart.
      usage: total
    })
    if (restart || this.turnActive) return
    void this.refreshContext()
    void this.refreshUsage()
  }
}
