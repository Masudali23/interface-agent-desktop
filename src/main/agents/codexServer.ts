// One `codex app-server` process per ChatGPT account. This is the JSON-RPC protocol the
// Codex desktop app and IDE extension use, so threads, streaming, approvals, models,
// rate limits, sign-in and MCP all behave exactly as they do there.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lineReader } from './types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ThreadHandler {
  notify(method: string, params: Json): void
  request(id: number | string, method: string, params: Json): void
  closed(): void
}

export class CodexServer extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private threads = new Map<string, ThreadHandler>()
  stderrTail = ''

  constructor(
    private binary: string,
    private env: () => NodeJS.ProcessEnv,
    private version: string
  ) {
    super()
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null
  }

  start(): Promise<void> {
    if (this.ready && this.running) return this.ready
    const proc = spawn(this.binary, ['app-server'], { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.stderrTail = ''
    proc.stdout.on('data', lineReader((line) => this.onLine(line)))
    proc.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000)
    })
    proc.stdin.on('error', () => {})
    proc.on('error', (err) => {
      this.stderrTail += `\n${err.message}`
    })
    proc.on('exit', () => {
      if (this.proc !== proc) return
      this.proc = undefined
      this.ready = undefined
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(this.stderrTail.trim().split('\n').pop() || 'Codex app-server stopped'))
      }
      this.pending.clear()
      for (const t of this.threads.values()) t.closed()
      this.threads.clear()
      this.emit('exit')
    })
    this.ready = this.call('initialize', {
      clientInfo: { name: 'interface', title: 'Interface', version: this.version },
      capabilities: null
    }).then(() => this.notify('initialized', {}))
    this.ready.catch(() => {
      this.ready = undefined
    })
    return this.ready
  }

  private write(obj: Json): void {
    if (this.running) this.proc!.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  call<T = Json>(method: string, params: Json, timeoutMs = 60000): Promise<T> {
    if (!this.running) return Promise.reject(new Error('Codex app-server is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex did not answer ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject, timer })
      this.write({ id, method, params })
    })
  }

  /** Waits for start-up, then calls. */
  async request<T = Json>(method: string, params: Json, timeoutMs?: number): Promise<T> {
    await this.start()
    return this.call<T>(method, params, timeoutMs)
  }

  notify(method: string, params: Json): void {
    this.write({ method, params })
  }

  respond(id: number | string, result: Json): void {
    this.write({ id, result })
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32000, message } })
  }

  subscribe(threadId: string, handler: ThreadHandler): void {
    this.threads.set(threadId, handler)
  }

  unsubscribe(threadId: string, handler?: ThreadHandler): void {
    if (!handler || this.threads.get(threadId) === handler) this.threads.delete(threadId)
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'Codex request failed')))
      else p.resolve(msg.result ?? {})
      return
    }
    const params: Json = msg.params ?? {}
    const threadId: string | undefined = params.threadId ?? params.thread?.id
    const handler = threadId ? this.threads.get(threadId) : undefined
    if (msg.id !== undefined) {
      // A request from the server, such as an approval.
      if (handler) handler.request(msg.id, msg.method, params)
      else this.respondError(msg.id, 'No open conversation for this request')
      return
    }
    if (handler) handler.notify(msg.method, params)
    else this.emit('notification', msg.method, params)
  }

  dispose(): void {
    this.proc?.kill('SIGTERM')
    this.proc = undefined
    this.ready = undefined
  }
}
