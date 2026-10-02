// A running `claude -p --input-format stream-json --output-format stream-json` process,
// with request/response helpers for Claude Code's control protocol (the same protocol
// Claude desktop and the Agent SDK use to drive the CLI).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lineReader } from './types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ClaudeProcessOptions {
  binary: string
  cwd: string
  env: NodeJS.ProcessEnv
  args: string[]
}

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  stderrTail = ''
  exited = false

  constructor(opts: ClaudeProcessOptions) {
    super()
    const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    this.proc = spawn(opts.binary, [...base, ...opts.args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', lineReader((line) => this.onLine(line)))
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000)
    })
    this.proc.stdin.on('error', () => {})
    this.proc.on('error', (err) => {
      this.stderrTail += `\n${err.message}`
    })
    this.proc.on('exit', (code) => {
      this.exited = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Claude Code stopped'))
      }
      this.pending.clear()
      this.emit('exit', code)
    })
  }

  get alive(): boolean {
    return !this.exited && this.proc.exitCode === null
  }

  write(obj: unknown): void {
    if (this.alive) this.proc.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  /** Sends a control request and waits for its response. */
  request<T = Json>(request: Json, timeoutMs = 20000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('Claude Code is not running'))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Claude Code did not answer "${request.subtype}"`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject, timer })
      this.write({ type: 'control_request', request_id: id, request })
    })
  }

  respond(requestId: string, response: Json): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }

  respondError(requestId: string, error: string): void {
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
  }

  private onLine(line: string): void {
    let ev: Json
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.type === 'control_response') {
      const r = ev.response ?? {}
      const p = this.pending.get(r.request_id)
      if (!p) return
      this.pending.delete(r.request_id)
      clearTimeout(p.timer)
      if (r.subtype === 'error') p.reject(new Error(String(r.error ?? 'Request failed')))
      else p.resolve(r.response ?? {})
      return
    }
    if (ev.type === 'control_request') {
      this.emit('control', ev)
      return
    }
    if (ev.type === 'control_cancel_request') return
    this.emit('message', ev)
  }

  end(): void {
    if (!this.alive) return
    this.proc.stdin.end()
    const proc = this.proc
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGTERM')
    }, 1500)
  }

  kill(): void {
    if (this.alive) this.proc.kill('SIGTERM')
  }
}
