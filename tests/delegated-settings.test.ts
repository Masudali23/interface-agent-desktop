import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_SETTINGS, type MemberSettings } from '../src/shared/types'
import { ClaudeAgent, type ClaudeOptions } from '../src/main/agents/claude'
import type { ClaudeProcessOptions } from '../src/main/agents/claudeProcess'
import { CodexAgent } from '../src/main/agents/codex'
import type { CodexServer, ThreadHandler } from '../src/main/agents/codexServer'
import { CodexExecAgent } from '../src/main/agents/codexExec'
import type { AgentConnector, AgentEvent } from '../src/main/agents/types'

interface MockClaudeProcess extends EventEmitter {
  options: ClaudeProcessOptions
  alive: boolean
  stderrTail: string
  request: Mock
  write: Mock
  respond: Mock
  respondError: Mock
  end: Mock
  kill: Mock
}

const mocks = vi.hoisted(() => ({ claude: [] as MockClaudeProcess[] }))

vi.mock('../src/main/agents/claudeProcess', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ClaudeProcess: class extends EventEmitter implements MockClaudeProcess {
      alive = true
      stderrTail = ''
      request = vi.fn(async () => ({}))
      write = vi.fn()
      respond = vi.fn()
      respondError = vi.fn()
      end = vi.fn(() => { this.alive = false })
      kill = vi.fn(() => { this.alive = false; this.emit('exit', 0) })

      constructor(public options: ClaudeProcessOptions) {
        super()
        mocks.claude.push(this)
      }
    }
  }
})

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn()
}))

const connectors: AgentConnector[] = []
const baseSettings = (): MemberSettings => ({ ...DEFAULT_SETTINGS, model: 'saved-model', effort: 'high' })
const turn = { text: 'Do the delegated task', images: [] }
const overrides = { model: 'delegated-model', effort: 'low' }

function track<T extends AgentConnector>(agent: T): { agent: T; events: AgentEvent[] } {
  connectors.push(agent)
  const events: AgentEvent[] = []
  agent.on('event', (event) => events.push(event))
  return { agent, events }
}

function claude(settings = baseSettings()) {
  const options: ClaudeOptions = { binary: 'claude', cwd: '/project', env: {}, settings, sessionId: 'session-1' }
  return { ...track(new ClaudeAgent(options)), options }
}

function claudeResult(proc: MockClaudeProcess, extra: Record<string, unknown> = {}) {
  proc.emit('message', { type: 'result', subtype: 'success', usage: { output_tokens: 2 }, ...extra })
}

function cliValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

beforeEach(() => {
  mocks.claude.length = 0
  vi.clearAllMocks()
})

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.dispose()
})

describe('Claude delegated settings', () => {
  it('resumes the same session for one overridden turn and restores saved settings for a synchronous next send', () => {
    const { agent, options } = claude(Object.freeze(baseSettings()))
    agent.send(turn)
    const original = mocks.claude[0]
    original.emit('message', { type: 'system', subtype: 'init', session_id: 'session-1' })
    claudeResult(original)

    agent.send({ ...turn, overrides })
    const delegated = mocks.claude[1]
    expect(original.end).toHaveBeenCalledOnce()
    expect(cliValue(delegated.options.args, '--model')).toBe(overrides.model)
    expect(cliValue(delegated.options.args, '--effort')).toBe(overrides.effort)
    expect(cliValue(delegated.options.args, '--resume')).toBe('session-1')
    expect(delegated.options.args).not.toContain('--fork-session')
    expect(delegated.options.args).not.toContain('--resume-session-at')
    expect(options.settings).toEqual(baseSettings())

    agent.on('event', (event) => { if (event.t === 'turn-end') agent.send(turn) })
    claudeResult(delegated)
    const next = mocks.claude[2]
    expect(delegated.end).toHaveBeenCalledOnce()
    expect(cliValue(next.options.args, '--model')).toBe('saved-model')
    expect(cliValue(next.options.args, '--effort')).toBe('high')
    expect(cliValue(next.options.args, '--resume')).toBe('session-1')
    expect(next.end).not.toHaveBeenCalled()
    expect(agent.busy).toBe(true)
  })

  it('applies user changes live and keeps the latest saved choices for the next turn', () => {
    const { agent } = claude()
    agent.send({ ...turn, overrides })
    const proc = mocks.claude[0]
    const latest = { ...baseSettings(), model: 'user-model', effort: 'xhigh', permissionMode: 'plan' as const }
    agent.update(latest)
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'set_model', model: 'user-model' })
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh' } })
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'set_permission_mode', mode: 'plan' })

    claudeResult(proc)
    agent.send(turn)
    const args = mocks.claude[1].options.args
    expect(cliValue(args, '--model')).toBe('user-model')
    expect(cliValue(args, '--effort')).toBe('xhigh')
    expect(cliValue(args, '--permission-mode')).toBe('plan')
    expect(latest).toEqual({ ...baseSettings(), model: 'user-model', effort: 'xhigh', permissionMode: 'plan' })
  })

  it('lets an explicit user update to the saved values replace different live overrides', () => {
    const { agent } = claude()
    agent.send({ ...turn, overrides })
    const proc = mocks.claude[0]
    agent.update(baseSettings())
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'set_model', model: 'saved-model' })
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
    claudeResult(proc)
  })

  it('preserves a user reset to harness defaults even when effort cannot be cleared live', () => {
    const { agent } = claude()
    agent.send({ ...turn, overrides })
    const proc = mocks.claude[0]
    agent.update({ ...baseSettings(), model: '', effort: '' })
    expect(proc.request).toHaveBeenCalledWith({ subtype: 'set_model', model: null })
    expect(proc.request.mock.calls.some(([request]) => request.subtype === 'apply_flag_settings')).toBe(false)
    claudeResult(proc)
    agent.send(turn)
    const args = mocks.claude[1].options.args
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(cliValue(args, '--resume')).toBe('session-1')
  })

  it('keeps approvals and late live messages on the overridden turn until both results finish', async () => {
    const { agent, events } = claude()
    agent.send({ ...turn, overrides })
    const proc = mocks.claude[0]
    proc.emit('message', { type: 'user', uuid: 'start-1', isReplay: true, message: { content: turn.text } })
    proc.emit('control', { request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } })
    agent.answer('approval-1', { kind: 'allow' })
    expect(proc.respond).toHaveBeenCalledWith('approval-1', { behavior: 'allow', updatedInput: { command: 'pwd' } })
    expect(await agent.steer({ text: 'Also check tests', images: [] })).toBe(true)
    claudeResult(proc)
    expect(agent.busy).toBe(true)
    expect(proc.end).not.toHaveBeenCalled()
    expect(events.filter((event) => event.t === 'turn-end')).toHaveLength(0)

    proc.emit('message', { type: 'user', uuid: 'steer-1', isReplay: true, message: { content: 'Also check tests' } })
    claudeResult(proc)
    expect(proc.end).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.t === 'turn-end')).toEqual([
      expect.objectContaining({ ok: true, usage: expect.objectContaining({ outputTokens: 4 }) })
    ])
    agent.send(turn)
    expect(cliValue(mocks.claude[1].options.args, '--model')).toBe('saved-model')
  })

  it.each(['failure', 'interruption', 'exit'] as const)('drops delegated settings after %s without losing the session', (ending) => {
    const { agent } = claude()
    agent.send({ ...turn, overrides })
    const proc = mocks.claude[0]
    if (ending === 'exit') proc.emit('exit', 1)
    else {
      if (ending === 'interruption') agent.interrupt()
      claudeResult(proc, { is_error: true, result: 'Stopped' })
    }
    agent.send(turn)
    expect(cliValue(mocks.claude[1].options.args, '--model')).toBe('saved-model')
    expect(cliValue(mocks.claude[1].options.args, '--resume')).toBe('session-1')
  })

  it('reuses the process when override values equal the saved settings', () => {
    const { agent } = claude()
    agent.send({ ...turn, overrides: { model: 'saved-model', effort: 'high' } })
    claudeResult(mocks.claude[0])
    agent.send(turn)
    expect(mocks.claude).toHaveLength(1)
    expect(mocks.claude[0].end).not.toHaveBeenCalled()
  })
})

function codex(settings = baseSettings()) {
  const handlers = new Map<string, ThreadHandler>()
  let turnNumber = 0
  const server = {
    running: true,
    start: vi.fn(async () => {}),
    call: vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'turn/start') return { turn: { id: `turn-${++turnNumber}` } }
      return { thread: { id: 'thread-1' } }
    }),
    subscribe: vi.fn((id: string, handler: ThreadHandler) => { handlers.set(id, handler) }),
    unsubscribe: vi.fn(),
    respond: vi.fn(),
    respondError: vi.fn()
  }
  const options = { server: server as unknown as CodexServer, cwd: '/project', settings, defaultModel: () => 'account-default' }
  const result = track(new CodexAgent(options))
  const starts = () => server.call.mock.calls.filter(([method]) => method === 'turn/start').map(([, params]) => params)
  const complete = () => handlers.get('thread-1')!.notify('turn/completed', { turn: { id: `turn-${turnNumber}`, status: 'completed' } })
  return { ...result, options, server, starts, complete }
}

describe('Codex app-server delegated settings', () => {
  it('overrides only turn/start and sends the latest saved settings on the following turn', async () => {
    const { agent, options, server, starts, complete } = codex(Object.freeze(baseSettings()))
    agent.send({ ...turn, overrides })
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(server.call).toHaveBeenCalledWith('thread/start', expect.objectContaining({ model: 'saved-model' }))
    expect(starts()[0]).toMatchObject({ model: 'delegated-model', effort: 'low', threadId: 'thread-1' })
    expect(options.settings).toEqual(baseSettings())
    agent.update({ ...baseSettings(), model: 'user-model', effort: 'xhigh' })
    complete()

    agent.send(turn)
    await vi.waitFor(() => expect(starts()).toHaveLength(2))
    expect(starts()[1]).toMatchObject({ model: 'user-model', effort: 'xhigh', threadId: 'thread-1' })
    expect(server.call.mock.calls.filter(([method]) => method.startsWith('thread/'))).toHaveLength(1)
    complete()
  })

  it('supports a partial override and returns to the saved model and effort', async () => {
    const { agent, starts, complete } = codex()
    agent.send({ ...turn, overrides: { effort: 'low' } })
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(starts()[0]).toMatchObject({ model: 'saved-model', effort: 'low' })
    complete()
    agent.send(turn)
    await vi.waitFor(() => expect(starts()).toHaveLength(2))
    expect(starts()[1]).toMatchObject({ model: 'saved-model', effort: 'high' })
    complete()
  })

  it('uses the account default for an explicit default-model override without persisting it', async () => {
    const { agent, starts, complete } = codex()
    agent.send({ ...turn, overrides: { model: '', effort: '' } })
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(starts()[0]).toMatchObject({ model: 'account-default', effort: null })
    complete()
    agent.send(turn)
    await vi.waitFor(() => expect(starts()).toHaveLength(2))
    expect(starts()[1]).toMatchObject({ model: 'saved-model', effort: 'high' })
    complete()
  })
})

function exec(settings = baseSettings()) {
  const children: Array<ReturnType<typeof childProcess>> = []
  vi.mocked(spawn).mockImplementation(() => {
    const proc = childProcess()
    children.push(proc)
    return proc as unknown as ReturnType<typeof spawn>
  })
  const options = { binary: 'codex', cwd: '/project', env: {}, settings }
  const result = track(new CodexExecAgent(options))
  const args = (index: number) => vi.mocked(spawn).mock.calls[index][1] as string[]
  const output = (index: number, event: object) => children[index].stdout.write(`${JSON.stringify(event)}\n`)
  return { ...result, options, children, args, output }
}

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true)
  })
}

describe('Codex exec delegated settings', () => {
  it('passes temporary args and resumes with settings changed while the delegated turn ran', () => {
    const { agent, options, args, output } = exec(Object.freeze(baseSettings()))
    agent.send({ ...turn, overrides })
    expect(cliValue(args(0), '-m')).toBe('delegated-model')
    expect(args(0)).toContain('model_reasoning_effort="low"')
    expect(options.settings).toEqual(baseSettings())
    output(0, { type: 'thread.started', thread_id: 'thread-1' })
    agent.update({ ...baseSettings(), model: 'user-model', effort: 'xhigh' })
    output(0, { type: 'turn.completed', usage: {} })

    agent.send(turn)
    expect(args(1).slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args(1)).toContain('thread-1')
    expect(cliValue(args(1), '-m')).toBe('user-model')
    expect(args(1)).toContain('model_reasoning_effort="xhigh"')
  })

  it('restores saved args on the next turn when no user settings changed', () => {
    const { agent, args, output } = exec()
    agent.send({ ...turn, overrides: { model: 'delegated-model' } })
    expect(args(0)).toContain('model_reasoning_effort="high"')
    output(0, { type: 'turn.completed', usage: {} })
    agent.send(turn)
    expect(cliValue(args(1), '-m')).toBe('saved-model')
    expect(args(1)).toContain('model_reasoning_effort="high"')
  })

  it('ignores old process output and exit when a completion starts the next turn immediately', () => {
    const { agent, events, children, output } = exec()
    agent.send({ ...turn, overrides })
    agent.on('event', (event) => { if (event.t === 'turn-end') agent.send(turn) })
    output(0, { type: 'turn.completed', usage: {} })
    expect(children).toHaveLength(2)
    output(0, { type: 'turn.failed', error: { message: 'Late event from previous process' } })
    children[0].emit('exit', 0)
    expect(children).toHaveLength(2)
    expect(agent.busy).toBe(true)
    expect(events.filter((event) => event.t === 'turn-end')).toHaveLength(1)
    children[0].stderr.write('Stale error from previous process')
    children[0].emit('error', new Error('Stale process error'))
    children[1].emit('exit', 7)
    expect(events.filter((event) => event.t === 'turn-end').at(-1)).toMatchObject({ error: 'Codex exited (code 7).' })
  })

  it('uses full-access sandbox and never approvals for both new and resumed turns', () => {
    const { agent, args, output } = exec({ ...baseSettings(), codexMode: 'full' })
    agent.send(turn)
    expect(cliValue(args(0), '-s')).toBe('danger-full-access')
    expect(args(0)).toContain('approval_policy="never"')
    output(0, { type: 'thread.started', thread_id: 'thread-1' })
    output(0, { type: 'turn.completed', usage: {} })
    agent.send(turn)
    expect(args(1)).toContain('sandbox_mode="danger-full-access"')
    expect(args(1)).toContain('approval_policy="never"')
  })

  it('counts reasoning tokens once when exec reports total output and reasoning output', () => {
    const { agent, events, output } = exec()
    agent.send(turn)
    output(0, { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 60 } })
    expect(events).toContainEqual({ t: 'turn-end', ok: true, usage: { inputTokens: 100, outputTokens: 80 } })
  })
})
