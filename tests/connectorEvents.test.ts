import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { ClaudeAgent } from '../src/main/agents/claude'
import { CodexAgent } from '../src/main/agents/codex'
import type { CodexServer } from '../src/main/agents/codexServer'
import type { AgentEvent } from '../src/main/agents/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const processes = vi.hoisted(() => [] as Array<EventEmitter & { write: Mock }>)
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

const progress = (events: AgentEvent[]): number[] => events.flatMap((e) => e.t === 'progress' ? [e.outputTokens] : [])
const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event })

describe('live output tokens', () => {
  it('adds up Claude API messages across the turn, including results carried by a late steer', async () => {
    const agent = new ClaudeAgent({ binary: 'claude', cwd: '/project', env: {}, settings: { ...DEFAULT_SETTINGS } })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    try {
      agent.send({ text: 'Task', images: [] })
      const proc = processes.at(-1)!
      proc.emit('message', { type: 'user', uuid: 'start-1', isReplay: true, message: { content: 'Task' } })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-1', usage: { output_tokens: 1 } } }))
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 40 } }))
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 40 } }))
      proc.emit('message', { type: 'stream_event', parent_tool_use_id: 'agent-1', event: { type: 'message_delta', usage: { output_tokens: 999 } } })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-2', usage: { output_tokens: 2 } } }))
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 25 } }))
      expect(progress(events)).toEqual([1, 40, 42, 65])

      expect(await agent.steer({ text: 'Late feedback', images: [] })).toBe(true)
      proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 70 } })
      expect(progress(events).at(-1)).toBe(70)
      proc.emit('message', { type: 'user', uuid: 'steer-1', isReplay: true, message: { content: 'Late feedback' } })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-3', usage: { output_tokens: 3 } } }))
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 10 } }))
      expect(progress(events).at(-1)).toBe(80)
      proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 10 } })
      expect(events.at(-1)).toMatchObject({ t: 'turn-end', usage: { outputTokens: 80 } })

      events.length = 0
      agent.send({ text: 'Next task', images: [] })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-4', usage: { output_tokens: 5 } } }))
      expect(progress(events)).toEqual([5])
    } finally {
      agent.dispose()
    }
  })

  it('counts Claude thinking estimates until the message reports its real usage', () => {
    const agent = new ClaudeAgent({ binary: 'claude', cwd: '/project', env: {}, settings: { ...DEFAULT_SETTINGS } })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    try {
      agent.send({ text: 'Task', images: [] })
      const proc = processes.at(-1)!
      const thinking = (estimated: number, extra: Record<string, unknown> = {}) =>
        proc.emit('message', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: 1, ...extra })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-1', usage: { output_tokens: 1 } } }))
      thinking(50)
      thinking(158)
      thinking(400, { parent_tool_use_id: 'agent-1' })
      expect(progress(events)).toEqual([1, 50, 158])
      // The real usage covers the thinking, so the estimate is not added on top.
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 170 } }))
      expect(progress(events).at(-1)).toBe(170)
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-2', usage: { output_tokens: 1 } } }))
      thinking(60)
      expect(progress(events).at(-1)).toBe(230)
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-3', usage: { output_tokens: 2 } } }))
      expect(progress(events).at(-1)).toBe(232)
    } finally {
      agent.dispose()
    }
  })

  it('adds up Codex token usage updates of the running turn', () => {
    const server = { start: vi.fn(async () => {}), call: vi.fn(() => new Promise(() => {})), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const agent = new CodexAgent({ server: server as unknown as CodexServer, cwd: '/project', settings: { ...DEFAULT_SETTINGS }, threadId: 'thread-1' })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    const notify = (params: Record<string, unknown>) =>
      (agent as unknown as { onNotification(method: string, params: Record<string, unknown>): void }).onNotification('thread/tokenUsage/updated', params)
    notify({ tokenUsage: { last: { outputTokens: 7 } } })
    expect(progress(events)).toEqual([])
    agent.send({ text: 'Task', images: [] })
    notify({ tokenUsage: { last: { inputTokens: 100, outputTokens: 12 } } })
    notify({ tokenUsage: { last: { inputTokens: 120, outputTokens: 30 } } })
    expect(progress(events)).toEqual([12, 42])
  })

  it('skips Codex token usage updates that repeat unchanged thread totals', () => {
    const server = { start: vi.fn(async () => {}), call: vi.fn(() => new Promise(() => {})), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const agent = new CodexAgent({ server: server as unknown as CodexServer, cwd: '/project', settings: { ...DEFAULT_SETTINGS }, threadId: 'thread-1' })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    const notify = (method: string, params: Record<string, unknown>) =>
      (agent as unknown as { onNotification(method: string, params: Record<string, unknown>): void }).onNotification(method, params)
    const usage = (last: number, total: number) => notify('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 't1',
      tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: last }, total: { inputTokens: 5000, outputTokens: total, totalTokens: 5000 + total } }
    })
    agent.send({ text: 'Task', images: [] })
    // Two model calls, each reported again when only the rate limits changed.
    usage(450, 2212)
    usage(450, 2212)
    usage(199, 2411)
    usage(199, 2411)
    expect(progress(events)).toEqual([450, 649])
    notify('turn/completed', { turn: { id: 't1', status: 'completed', durationMs: 10 } })
    expect(events.at(-1)).toMatchObject({ t: 'turn-end', usage: { inputTokens: 2000, cachedTokens: 1600, outputTokens: 649, steps: 2 } })

    // A repeat at the start of the next turn belongs to the previous one.
    events.length = 0
    agent.send({ text: 'Next', images: [] })
    usage(199, 2411)
    usage(80, 2491)
    expect(progress(events)).toEqual([80])
  })

  it('never lowers Claude live output tokens when real usage comes in below the thinking estimate', () => {
    const agent = new ClaudeAgent({ binary: 'claude', cwd: '/project', env: {}, settings: { ...DEFAULT_SETTINGS } })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    try {
      agent.send({ text: 'Task', images: [] })
      const proc = processes.at(-1)!
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-1', usage: { output_tokens: 1 } } }))
      proc.emit('message', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 900, estimated_tokens_delta: 1 })
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 700 } }))
      expect(progress(events)).toEqual([1, 900])
      // The next message counts on from the real figure once it passes what was shown.
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-2', usage: { output_tokens: 1 } } }))
      proc.emit('message', stream({ type: 'message_delta', usage: { output_tokens: 250 } }))
      expect(progress(events)).toEqual([1, 900, 950])
      proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 950 } })

      events.length = 0
      agent.send({ text: 'Next task', images: [] })
      proc.emit('message', stream({ type: 'message_start', message: { id: 'api-3', usage: { output_tokens: 4 } } }))
      expect(progress(events)).toEqual([4])
    } finally {
      agent.dispose()
    }
  })
})

describe('Codex plan versions', () => {
  it('records each changed plan as a new block and closes the previous one', () => {
    const server = { start: vi.fn(async () => {}), call: vi.fn(() => new Promise(() => {})), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const agent = new CodexAgent({ server: server as unknown as CodexServer, cwd: '/project', settings: { ...DEFAULT_SETTINGS }, threadId: 'thread-1' })
    const events: AgentEvent[] = []
    agent.on('event', (event) => events.push(event))
    const notify = (method: string, params: Record<string, unknown>) =>
      (agent as unknown as { onNotification(method: string, params: Record<string, unknown>): void }).onNotification(method, params)
    agent.send({ text: 'Task', images: [] })
    events.length = 0
    const plan = (status: string) => ({ turnId: 't1', plan: [{ step: 'Write tests', status }] })
    notify('turn/plan/updated', plan('inProgress'))
    notify('turn/plan/updated', plan('inProgress'))
    notify('turn/plan/updated', plan('completed'))
    notify('turn/completed', { turn: { id: 't1', status: 'completed' } })
    const planEvents = events.filter((e) => e.t === 'tool-start' || e.t === 'tool-end')
    expect(planEvents).toEqual([
      { t: 'tool-start', id: 'codex-plan-t1-1', name: 'Plan', input: { items: [{ text: 'Write tests', status: 'in_progress' }], explanation: undefined } },
      { t: 'tool-end', id: 'codex-plan-t1-1' },
      { t: 'tool-start', id: 'codex-plan-t1-2', name: 'Plan', input: { items: [{ text: 'Write tests', status: 'completed' }], explanation: undefined } },
      { t: 'tool-end', id: 'codex-plan-t1-2' }
    ])
  })
})
