import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { addUsage, ClaudeAgent } from '../src/main/agents/claude'
import { neverAsks } from '../src/main/rooms'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { AgentEvent } from '../src/main/agents/types'

const processes = vi.hoisted(() => [] as Array<EventEmitter & { write: Mock; request: Mock }>)
vi.mock('../src/main/agents/claudeProcess', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ClaudeProcess: class extends EventEmitter {
      alive = true
      request = vi.fn(async () => ({}))
      write = vi.fn()
      end = vi.fn(() => { this.alive = false })
      constructor() { super(); processes.push(this) }
    }
  }
})

const member = (provider: 'claude' | 'codex', settings: Record<string, string>) => ({ provider, settings }) as never

describe('full access never asks', () => {
  it('Codex Full access and Claude Bypass skip approvals', () => {
    expect(neverAsks(member('codex', { codexMode: 'full', permissionMode: 'default' }))).toBe(true)
    expect(neverAsks(member('claude', { codexMode: 'auto', permissionMode: 'bypassPermissions' }))).toBe(true)
  })
  it('every other mode still asks', () => {
    expect(neverAsks(member('codex', { codexMode: 'auto', permissionMode: 'bypassPermissions' }))).toBe(false)
    expect(neverAsks(member('claude', { codexMode: 'full', permissionMode: 'auto' }))).toBe(false)
  })
})

describe('one reply spanning two Claude Code results', () => {
  it('adds the usage of both', () => {
    const a = { inputTokens: 100, cachedTokens: 60, outputTokens: 10, steps: 2, durationMs: 1000 }
    const b = { inputTokens: 50, cachedTokens: 40, outputTokens: 5, steps: 1, durationMs: 500 }
    expect(addUsage(a, b)).toEqual({ inputTokens: 150, cachedTokens: 100, outputTokens: 15, steps: 3, durationMs: 1500 })
    expect(addUsage(undefined, b)).toBe(b)
  })

  it('accepts startup feedback before initialization and preserves it across a late result', async () => {
    const agent = new ClaudeAgent({ binary: 'claude', cwd: '/project', env: {}, settings: { ...DEFAULT_SETTINGS } })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    try {
      agent.send({ text: 'Original task', images: [] })
      const proc = processes.at(-1)!
      // No initialize response or first user replay has been processed yet.
      const accepted = agent.steer({ text: 'Startup correction', images: [] })
      expect(proc.write.mock.calls.map(([input]) => input.message.content)).toEqual(['Original task', 'Startup correction'])
      expect(await accepted).toBe(true)
      proc.emit('message', { type: 'user', uuid: 'start-1', isReplay: true, message: { content: 'Original task' } })
      expect(events).toContainEqual({ t: 'turn-ref', start: 'start-1' })
      proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 2 } })
      expect(events.filter((event) => event.t === 'turn-end')).toHaveLength(0)
      proc.emit('message', { type: 'user', uuid: 'steer-1', isReplay: true, message: { content: 'Startup correction' } })
      proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 3 } })
      expect(events.filter((event) => event.t === 'turn-end')).toEqual([
        expect.objectContaining({ ok: true, usage: expect.objectContaining({ outputTokens: 5 }) })
      ])
      expect(agent.busy).toBe(false)
    } finally { agent.dispose() }
  })
})
