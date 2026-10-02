// Fallback connector for Codex versions without `codex app-server`.
//
// Each turn runs the official `codex exec --json` (or `codex exec resume <thread>`)
// in the room's folder. Safety comes from Codex's sandbox mode only, because exec
// mode has no interactive approvals.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { McpServer, MemberSettings } from '@shared/types'
import { sandboxMode } from './codex'
import { clip, lineReader, type AgentConnector, type AgentEvent, type TurnInput } from './types'

export interface CodexExecOptions {
  binary: string
  cwd: string
  env: NodeJS.ProcessEnv
  settings: MemberSettings
  threadId?: string
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function unwrapShell(command: string): string {
  const m = /^\/(?:usr\/)?bin\/(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return m ? m[2] : command
}

function errorText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  try {
    const parsed = JSON.parse(text)
    return parsed?.error?.message ?? parsed?.message ?? text
  } catch {
    return text
  }
}

export class CodexExecAgent extends EventEmitter implements AgentConnector {
  private proc?: ChildProcessWithoutNullStreams
  private turnActive = false
  private stopping = false
  private ended = false
  private sawThread = false
  private stopTimer?: NodeJS.Timeout
  private stderrTail = ''
  private lastError = ''
  private seenTools = new Set<string>()

  constructor(private opts: CodexExecOptions) {
    super()
  }

  get busy(): boolean {
    return this.turnActive
  }

  update(settings: MemberSettings): void {
    this.opts = { ...this.opts, settings }
  }

  async forkAt(): Promise<void> {
    // exec mode cannot fork a thread: start a new one.
    if (this.turnActive) throw new Error('Wait for GPT to finish first.')
    this.opts.threadId = undefined
  }

  async refreshContext(): Promise<void> {}

  async mcpList(): Promise<McpServer[]> {
    return []
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e)
  }

  private args(images: string[], overrides?: TurnInput['overrides']): string[] {
    const s = {
      ...this.opts.settings,
      model: overrides?.model ?? this.opts.settings.model,
      effort: overrides?.effort ?? this.opts.settings.effort
    }
    const thread = this.opts.threadId
    const args = thread ? ['exec', 'resume'] : ['exec']
    for (const img of images) args.push('-i', img)
    args.push('--json', '--skip-git-repo-check')
    if (s.model) args.push('-m', s.model)
    if (s.effort) args.push('-c', `model_reasoning_effort="${s.effort}"`)
    if (s.codexMode === 'full') args.push('-c', 'approval_policy="never"')
    const sandbox = sandboxMode(s.codexMode)
    if (thread) args.push('-c', `sandbox_mode="${sandbox}"`, thread)
    else args.push('-s', sandbox, '-C', this.opts.cwd)
    args.push('-')
    return args
  }

  send(input: TurnInput): void {
    const images = input.images.filter((a) => IMAGE_TYPES.has(a.mime)).map((a) => a.path)
    this.turnActive = true
    this.stopping = false
    this.ended = false
    this.sawThread = false
    this.stderrTail = ''
    this.lastError = ''
    this.seenTools.clear()
    const proc = spawn(this.opts.binary, this.args(images, input.overrides), {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc
    proc.stdout.on('data', lineReader((line) => this.proc === proc && this.onLine(line)))
    proc.stderr.on('data', (d: Buffer) => {
      if (this.proc !== proc) return
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000)
    })
    proc.stdin.on('error', () => {})
    proc.on('error', (err) => {
      if (this.proc !== proc) return
      this.stderrTail += `\n${err.message}`
    })
    proc.on('exit', (code) => this.onExit(proc, code))
    proc.stdin.end(input.text)
    this.emitEvent({ t: 'status', status: 'thinking' })
  }

  interrupt(): void {
    if (!this.turnActive || !this.proc) return
    this.stopping = true
    this.proc.kill('SIGINT')
    clearTimeout(this.stopTimer)
    const proc = this.proc
    this.stopTimer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGTERM')
    }, 3000)
  }

  answer(): void {
    // Codex exec mode never asks; the sandbox decides.
  }

  dispose(): void {
    this.removeAllListeners()
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGTERM')
  }

  private finish(e: Extract<AgentEvent, { t: 'turn-end' }>): void {
    if (this.ended) return
    this.ended = true
    this.turnActive = false
    clearTimeout(this.stopTimer)
    this.emitEvent(e)
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null): void {
    // turn.completed can start the next process before the previous one exits.
    if (this.proc !== proc) return
    this.proc = undefined
    if (this.ended) return
    if (this.opts.threadId && !this.sawThread && /(no|not) (saved )?(session|thread|rollout)|not found/i.test(this.stderrTail)) {
      this.opts.threadId = undefined
      this.ended = true
      this.turnActive = false
      this.emitEvent({ t: 'session-invalid' })
      return
    }
    const detail = this.lastError || this.stderrTail.trim().split('\n').slice(-6).join('\n')
    this.finish({
      t: 'turn-end',
      ok: false,
      stopped: this.stopping,
      error: this.stopping ? undefined : detail || `Codex exited (code ${code ?? 'unknown'}).`
    })
  }

  private onLine(line: string): void {
    let ev: Json
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    switch (ev.type) {
      case 'thread.started':
        this.sawThread = true
        if (ev.thread_id) {
          this.opts.threadId = ev.thread_id
          this.emitEvent({ t: 'session', id: ev.thread_id })
        }
        return
      case 'turn.started':
        this.sawThread = true
        this.emitEvent({ t: 'status', status: 'thinking' })
        return
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.onItem(ev.item ?? {}, ev.type === 'item.completed')
      case 'turn.completed': {
        const u = ev.usage ?? {}
        return this.finish({
          t: 'turn-end',
          ok: true,
          // Codex includes reasoning in output_tokens already.
          usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens ?? 0 }
        })
      }
      case 'turn.failed':
        return this.finish({
          t: 'turn-end',
          ok: false,
          stopped: this.stopping,
          error: errorText(ev.error?.message ?? ev.error)
        })
      case 'error':
        this.lastError = errorText(ev.message)
        return
    }
  }

  private startTool(id: string, name: string, input: unknown): void {
    if (this.seenTools.has(id)) {
      this.emitEvent({ t: 'tool-input', id, name, input })
      return
    }
    this.seenTools.add(id)
    this.emitEvent({ t: 'tool-start', id, name, input })
    this.emitEvent({ t: 'status', status: 'working', detail: name })
  }

  private onItem(item: Json, done: boolean): void {
    const id = `codex-${item.id}`
    switch (item.type) {
      case 'agent_message':
        if (item.text) this.emitEvent({ t: 'block-set', key: id, kind: 'text', text: item.text })
        return
      case 'reasoning':
        if (item.text) this.emitEvent({ t: 'block-set', key: id, kind: 'thinking', text: item.text })
        return
      case 'command_execution': {
        this.startTool(id, 'Shell', { command: unwrapShell(String(item.command ?? '')) })
        if (done) {
          const failed = item.status === 'failed' || item.status === 'declined' || (item.exit_code ?? 0) !== 0
          this.emitEvent({ t: 'tool-end', id, output: clip(String(item.aggregated_output ?? '')), isError: failed })
        }
        return
      }
      case 'file_change': {
        const changes: Json[] = Array.isArray(item.changes) ? item.changes : []
        this.startTool(id, 'Edit files', { changes })
        if (done) {
          const output = changes.map((c) => `${c.kind ?? 'update'}: ${c.path}`).join('\n')
          this.emitEvent({ t: 'tool-end', id, output, isError: item.status === 'failed' })
        }
        return
      }
      case 'mcp_tool_call': {
        this.startTool(id, `${item.server ?? 'mcp'}: ${item.tool ?? 'tool'}`, item.arguments ?? {})
        if (done) {
          const out = item.error ? errorText(item.error) : JSON.stringify(item.result ?? '', null, 2)
          this.emitEvent({ t: 'tool-end', id, output: clip(out), isError: !!item.error || item.status === 'failed' })
        }
        return
      }
      case 'web_search':
        this.startTool(id, 'Web search', { query: item.query })
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'todo_list':
        this.startTool(id, 'Plan', { items: item.items ?? [] })
        if (done) this.emitEvent({ t: 'tool-end', id })
        return
      case 'error':
        // Non-fatal notices (for example model metadata warnings).
        return
    }
  }
}
