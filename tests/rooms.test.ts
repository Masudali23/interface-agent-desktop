import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_ROOM_DEFAULTS, DEFAULT_SETTINGS, type Account, type Attachment, type Member, type MemberSettings, type Room } from '../src/shared/types'
import { RoomManager, type RoomHost } from '../src/main/rooms'
import type { Store } from '../src/main/store'
import type { AccountManager } from '../src/main/accounts'
import type { AgentEvent, TurnInput } from '../src/main/agents/types'
import { diffTrees, restoreTree, snapshot } from '../src/main/git'

interface MockConnector extends EventEmitter {
  options: { settings: MemberSettings; cwd: string }
  busy: boolean
  send: Mock<(input: TurnInput) => void>
  steer: Mock<(input: TurnInput) => Promise<boolean>>
  update: Mock
  interrupt: Mock
  answer: Mock
  forkAt: Mock
  undoFiles: Mock
  dispose: Mock
  report(event: AgentEvent): void
}

const mocks = vi.hoisted(() => ({ connectors: [] as MockConnector[] }))

vi.mock('../src/main/agents/claude', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ClaudeAgent: class extends EventEmitter implements MockConnector {
      busy = false
      send = vi.fn((_input: TurnInput) => {
        this.busy = true
        this.report({ t: 'status', status: 'thinking' })
      })
      steer = vi.fn(async (_input: TurnInput) => false)
      update = vi.fn()
      interrupt = vi.fn(() => this.report({ t: 'turn-end', ok: false, stopped: true }))
      forkAt = vi.fn(async () => {})
      undoFiles = vi.fn(async () => 'Connector undo')
      refreshContext = vi.fn(async () => {})
      mcpList = vi.fn(async () => [])
      answer = vi.fn()
      dispose = vi.fn(() => this.removeAllListeners())

      constructor(public options: MockConnector['options']) {
        super()
        mocks.connectors.push(this)
      }

      report(event: AgentEvent) {
        if (event.t === 'turn-end') this.busy = false
        this.emit('event', event)
      }
    }
  }
})

vi.mock('../src/main/agents/codex', async () => ({ CodexAgent: (await import('../src/main/agents/claude')).ClaudeAgent }))
vi.mock('../src/main/agents/codexExec', async () => ({ CodexExecAgent: (await import('../src/main/agents/claude')).ClaudeAgent }))
vi.mock('../src/main/git', () => ({
  snapshot: vi.fn(), diffTrees: vi.fn(), restoreTree: vi.fn(),
  addWorktree: vi.fn(), mergeWorktree: vi.fn(), removeWorktree: vi.fn(), resetWorktree: vi.fn()
}))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  appendFileSync: vi.fn(), existsSync: vi.fn(() => true), mkdirSync: vi.fn(), writeFileSync: vi.fn()
}))

const managers: RoomManager[] = []
const member = (id: string, provider: 'claude' | 'codex'): Member => ({
  id, provider, accountId: `acc-${id}`, name: id, handle: provider === 'claude' ? 'claude' : 'gpt', color: '#000',
  settings: { ...DEFAULT_SETTINGS, model: 'saved-model', effort: 'high' }
})
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const attachment: Attachment = { name: 'reference.png', path: '/project/reference.png', size: 10, mime: 'image/png' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(patch: Partial<Room> = {}) {
  const room: Room = {
    id: 'room-1', title: 'Test room', folder: '/project', kind: 'team', createdAt: 0, updatedAt: 0,
    members: [member('a', 'claude'), member('b', 'codex')], autoRelay: true, maxHops: 6,
    isolation: false, sessions: {}, messages: [], dispatch: 'lead', leadId: 'a', ...patch
  }
  const rooms = new Map([[room.id, room]])
  const store = {
    get: vi.fn((id: string) => rooms.get(id)), all: vi.fn(() => [...rooms.values()]),
    summary: vi.fn((value: Room) => value), put: vi.fn((value: Room) => rooms.set(value.id, value)),
    saveSoon: vi.fn(), saveNow: vi.fn(), addRecentFolder: vi.fn(), delete: vi.fn((id: string) => rooms.delete(id)),
    settings: { defaults: DEFAULT_ROOM_DEFAULTS }
  }
  const catalog = [
    { id: 'saved-model', label: 'Saved model', efforts: ['high', 'xhigh'], isDefault: true },
    { id: 'delegated-model', label: 'Delegated model', efforts: ['low', 'medium'] },
    { id: 'user-model', label: 'User model', efforts: ['high', 'xhigh'] }
  ]
  const accounts = {
    meta: new Map(room.members.map((m) => [m.accountId, { models: catalog }])),
    get: vi.fn((id: string) => {
      const m = room.members.find((candidate) => candidate.accountId === id)
      return m ? { id, provider: m.provider, name: m.name, handle: m.handle, color: m.color, createdAt: 0 } as Account : undefined
    }),
    env: vi.fn(() => ({})), codexServer: vi.fn(() => ({})), defaultModel: vi.fn(() => 'saved-model'),
    setMeta: vi.fn(), fromAgent: vi.fn()
  }
  const host: RoomHost = {
    emit: vi.fn(), notify: vi.fn(), binaries: () => ({ claude: 'claude', codex: 'codex' }),
    codexAppServer: () => true, dataDir: '/data'
  }
  const manager = new RoomManager(store as unknown as Store, accounts as unknown as AccountManager, host)
  managers.push(manager)
  const send = (text: string, to: string[] = ['a'], attachments: Attachment[] = []) => manager.send(room.id, { text, to, attachments })!
  const replies = (id: string) => room.messages.filter((m) => m.author === id)
  return { manager, room, send, replies, store, accounts, host }
}

function complete(connector: MockConnector, text = 'Finished', ok = true) {
  connector.report({ t: 'block-set', key: 'answer', kind: 'text', text })
  connector.report({ t: 'turn-end', ok, error: ok ? undefined : 'Test failure' })
}

beforeEach(() => {
  mocks.connectors.length = 0
  vi.clearAllMocks()
  vi.mocked(snapshot).mockReset().mockResolvedValue('baseline')
  vi.mocked(diffTrees).mockResolvedValue('diff --git a/file.ts b/file.ts\n')
  vi.mocked(restoreTree).mockResolvedValue('Put back 1 file')
})

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll()
})

describe('RoomManager turn lifecycle', () => {
  it('never starts a turn stopped while its initial snapshot is pending', async () => {
    const initial = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    const { manager, room, send, replies } = setup()
    send('Start working')
    const connector = mocks.connectors[0]
    expect(connector.send).not.toHaveBeenCalled()
    manager.stop(room.id, 'a')
    initial.resolve('before')
    await settle()
    expect(connector.send).not.toHaveBeenCalled()
    expect(connector.interrupt).not.toHaveBeenCalled()
    expect(replies('a')[0].status).toBe('stopped')
    expect(manager.busyRooms()).toEqual([])
  })

  it('never starts a disposed runtime after its initial snapshot resolves', async () => {
    const initial = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    const { manager, send, replies } = setup()
    const original = send('Start working')
    const connector = mocks.connectors[0]
    manager.disposeAll()
    expect(original.deliveredTo).not.toContain('a')
    expect(replies('a')[0].status).toBe('stopped')
    initial.resolve('before')
    await settle()
    expect(connector.dispose).toHaveBeenCalledOnce()
    expect(connector.send).not.toHaveBeenCalled()
    expect(manager.busyRooms()).toEqual([])
  })

  it('waits for the ending snapshot and diff before starting a queued turn for the same agent', async () => {
    const ending = deferred<string>()
    const diff = deferred<string>()
    vi.mocked(snapshot).mockResolvedValueOnce('before').mockReturnValueOnce(ending.promise)
    vi.mocked(diffTrees).mockReturnValueOnce(diff.promise)
    const { manager, room, send, replies } = setup()
    send('First task')
    await settle()
    const connector = mocks.connectors[0]
    send('Second task')
    await settle()
    complete(connector)
    await settle()
    expect(connector.send).toHaveBeenCalledOnce()
    expect(manager.busyRooms()).toContain(room.id)
    ending.resolve('after')
    await settle()
    expect(connector.send).toHaveBeenCalledOnce()
    diff.resolve('the first turn diff')
    await settle()
    expect(connector.send).toHaveBeenCalledTimes(2)
    expect(connector.send.mock.calls[1][0].text).toContain('Second task')
    expect(replies('a')[0].snapshot).toMatchObject({ before: 'before', after: 'after' })
    expect(replies('a')[0].diff).toBe('the first turn diff')
  })

  it('cancels automatic relay when Stop is pressed while the ending snapshot is pending', async () => {
    const ending = deferred<string>()
    vi.mocked(snapshot).mockResolvedValueOnce('before').mockReturnValueOnce(ending.promise)
    const { manager, room, send, replies } = setup()
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], 'Prepared work\n→ @gpt: Implement worker.ts')
    manager.stop(room.id)
    ending.resolve('after')
    await settle()
    expect(mocks.connectors).toHaveLength(1)
    expect(replies('a')[0].handoffDone).toBe(false)
    expect(manager.busyRooms()).toEqual([])
  })

  it('still runs the turn when the initial snapshot fails', async () => {
    vi.mocked(snapshot).mockRejectedValueOnce(new Error('Snapshot unavailable'))
    const { send } = setup()
    send('Continue without a snapshot')
    await settle()
    expect(mocks.connectors[0].send).toHaveBeenCalledOnce()
  })

  it('does not resurrect a stopped turn when a pending steer later fails', async () => {
    const steering = deferred<boolean>()
    const { manager, room, send } = setup()
    send('First task')
    await settle()
    const connector = mocks.connectors[0]
    connector.steer.mockReturnValue(steering.promise)
    const followup = send('Late feedback')
    manager.stop(room.id, 'a')
    await settle()
    steering.resolve(false)
    await settle()
    expect(connector.send).toHaveBeenCalledOnce()
    expect(followup.deliveredTo).not.toContain('a')
    expect(manager.busyRooms()).toEqual([])
  })

  it('uses the lead for unmentioned messages and honors explicit recipients', async () => {
    const { send } = setup({ leadId: 'b' })
    send('Coordinate this task', [])
    await settle()
    expect(mocks.connectors).toHaveLength(1)
    expect(mocks.connectors[0].send.mock.calls[0][0].text).toContain("It's your turn, @gpt.")
    send('Explicit task', ['a'])
    await settle()
    expect(mocks.connectors).toHaveLength(2)
    expect(mocks.connectors[1].send.mock.calls[0][0].text).toContain("It's your turn, @claude.")
  })
})

describe('RoomManager shutdown delivery recovery', () => {
  it.each([true, false])('makes unacknowledged feedback available on reopen and ignores late acknowledgment (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { manager, room, send, replies, store } = setup()
    const original = send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    const correction = send('Correction to retain', ['b'])
    await settle()
    store.saveSoon.mockClear()
    manager.disposeAll()
    expect(correction.deliveredTo).not.toContain('b')
    expect(original.deliveredTo).toContain('b')
    expect(replies('b')[0].prompt!.text).toContain('Original task')
    expect(replies('b')[0].prompt!.text).not.toContain('Correction to retain')
    expect(replies('b')[0].inputMessageIds).not.toContain(correction.id)
    expect(store.saveSoon).toHaveBeenCalledWith(room.id)
    expect(manager.busyRooms()).toEqual([])

    send('Resume unfinished work', ['b'])
    await settle()
    const reopened = mocks.connectors[1]
    expect(reopened.send.mock.calls[0][0].text.match(/Correction to retain/g)).toHaveLength(1)
    acknowledgment.resolve(accepted)
    await settle()
    expect(correction.deliveredTo).toContain('b')
    expect(replies('b')[0].prompt!.text).not.toContain('Correction to retain')
    complete(reopened)
    await settle()
    expect(reopened.send).toHaveBeenCalledOnce()
  })

  it.each([true, false])('releases an unacknowledged handoff on shutdown (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { manager, room, send, replies } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    complete(lead, 'Review ready\n→ @gpt: Apply the revised review')
    await settle()
    const handoff = replies('a')[0]
    manager.disposeAll()
    expect(handoff.deliveredTo).not.toContain('b')
    expect(handoff.handoffDone).toBe(false)
    acknowledgment.resolve(accepted)
    await settle()
    expect(handoff.handoffDone).toBe(false)
    expect(mocks.connectors).toHaveLength(2)
    manager.continueHandoff(room.id, handoff.id)
    await settle()
    expect(mocks.connectors[2].send.mock.calls[0][0].text).toContain('Apply the revised review')
    expect(handoff.handoffDone).toBe(true)
  })

  it('releases queued delegated handoffs while retaining their requested settings', async () => {
    const { manager, room, send, replies } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    complete(lead, 'Review ready\n→ @gpt [model=delegated-model effort=low]: Apply the revised review')
    await settle()
    expect(worker.steer).not.toHaveBeenCalled()
    const handoff = replies('a')[0]
    expect(handoff.handoffDone).toBe(true)
    manager.disposeAll()
    expect(handoff.handoffDone).toBe(false)
    manager.continueHandoff(room.id, handoff.id)
    await settle()
    expect(mocks.connectors[2].send.mock.calls[0][0]).toMatchObject({ overrides: { model: 'delegated-model', effort: 'low' } })
  })

  it('releases a handoff reserved by an unsent initial snapshot', async () => {
    const initial = deferred<string>()
    const { manager, room, send, replies } = setup({ autoRelay: false })
    send('Plan the work')
    await settle()
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Apply the plan')
    await settle()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    const handoff = replies('a')[0]
    manager.continueHandoff(room.id, handoff.id)
    const worker = mocks.connectors[1]
    expect(worker.send).not.toHaveBeenCalled()
    manager.disposeAll()
    expect(handoff.handoffDone).toBe(false)
    expect(handoff.deliveredTo).not.toContain('b')
    initial.resolve('before')
    await settle()
    expect(worker.send).not.toHaveBeenCalled()
    expect(manager.busyRooms()).toEqual([])
  })

  it('releases a planned relay during the final snapshot without starting it after shutdown', async () => {
    const ending = deferred<string>()
    const { manager, send, replies } = setup()
    send('Plan the work')
    await settle()
    vi.mocked(snapshot).mockReturnValueOnce(ending.promise)
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Apply the plan')
    const handoff = replies('a')[0]
    expect(handoff.handoffDone).toBe(true)
    manager.disposeAll()
    expect(handoff.handoffDone).toBe(false)
    ending.resolve('after')
    await settle()
    expect(handoff.status).toBe('done')
    expect(handoff.handoffDone).toBe(false)
    expect(mocks.connectors).toHaveLength(1)
    expect(manager.busyRooms()).toEqual([])
  })

  it('preserves acknowledged feedback and handoffs across shutdown', async () => {
    const { manager, send, replies } = setup()
    const original = send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockResolvedValue(true)
    complete(lead, 'Review ready\n→ @gpt: Apply the revised review')
    await settle()
    const feedback = send('Accepted correction', ['b'])
    await settle()
    manager.disposeAll()
    expect(original.deliveredTo).toEqual(expect.arrayContaining(['a', 'b']))
    expect(feedback.deliveredTo).toContain('b')
    expect(replies('a')[0].handoffDone).toBe(true)
    expect(replies('a')[0].deliveredTo).toContain('b')
    expect(replies('b')[0].prompt!.text).toContain('Apply the revised review')
    expect(replies('b')[0].prompt!.text).toContain('Accepted correction')
    expect(replies('b')[0].inputMessageIds).toEqual(expect.arrayContaining([original.id, feedback.id, replies('a')[0].id]))
  })

  it.each(['a', 'b'])('releases an unsent queued slash command for %s', async (memberId) => {
    const { manager, send } = setup()
    send('Original task', [memberId])
    await settle()
    const command = send('/compact', [memberId])
    expect(command.deliveredTo).toContain(memberId)
    manager.disposeAll()
    expect(command.deliveredTo).not.toContain(memberId)
    expect(mocks.connectors[0].send).toHaveBeenCalledOnce()
  })

  it('releases unsent input before connector disposal and ignores synchronous and late disposal events', async () => {
    const acknowledgment = deferred<boolean>()
    const { manager, send, replies } = setup()
    send('Original task', ['a'])
    await settle()
    const connector = mocks.connectors[0]
    connector.steer.mockReturnValueOnce(acknowledgment.promise)
    const correction = send('Correction to retain', ['a'])
    await settle()
    connector.dispose.mockImplementation(() => {
      expect(correction.deliveredTo).not.toContain('a')
      complete(connector, 'Should not be relayed\n→ @gpt: Do not start')
      connector.report({ t: 'session-invalid' })
      connector.report({ t: 'status', status: 'working' })
    })
    manager.disposeAll()
    connector.report({ t: 'session-invalid' })
    acknowledgment.resolve(true)
    await settle()
    expect(replies('a')[0].status).toBe('stopped')
    expect(replies('a')[0].text).not.toContain('Should not be relayed')
    expect(correction.deliveredTo).not.toContain('a')
    expect(connector.send).toHaveBeenCalledOnce()
    expect(mocks.connectors).toHaveLength(1)
    expect(manager.busyRooms()).toEqual([])
  })
})

describe('RoomManager in-progress room feedback', () => {
  it('delivers an automatic handoff to the active turn without scheduling duplicate work', async () => {
    const { manager, room, send, replies } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockResolvedValue(true)
    complete(lead, 'Server changes are finished\n→ @gpt: Update the notice using the new behavior')
    await settle()
    expect(worker.steer).toHaveBeenCalledOnce()
    expect(worker.steer.mock.calls[0][0].text).toContain('Update the notice using the new behavior')
    expect(worker.steer.mock.calls[0][0].text).toContain('continuation of your current task')
    expect(replies('b')[0].inputMessageIds).toContain(replies('a')[0].id)
    expect(replies('a')[0].deliveredTo).toContain('b')
    expect(manager.statuses(room.id).b.queued).toBe(0)
    complete(worker, 'Combined task finished\n→ DONE')
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
    expect(replies('b')).toHaveLength(1)
    expect(manager.busyRooms()).toEqual([])
  })

  it('also delivers a manually continued handoff during a turn exactly once', async () => {
    const { manager, room, send, replies } = setup({ autoRelay: false })
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockResolvedValue(true)
    complete(lead, 'Review ready\n→ @gpt: Incorporate the review')
    await settle()
    manager.continueHandoff(room.id, replies('a')[0].id)
    manager.continueHandoff(room.id, replies('a')[0].id)
    await settle()
    expect(worker.steer).toHaveBeenCalledOnce()
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('folds feedback and attachments received during the initial snapshot into the first send', async () => {
    const initial = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    const { send, replies, manager, room } = setup()
    send('Implement the form', ['b'])
    const feedback = send('Use this revised design', ['b'], [attachment])
    const worker = mocks.connectors[0]
    expect(worker.steer).not.toHaveBeenCalled()
    initial.resolve('before')
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
    expect(worker.send.mock.calls[0][0].text).toContain('Implement the form')
    expect(worker.send.mock.calls[0][0].text).toContain('Use this revised design')
    expect(worker.send.mock.calls[0][0].images).toEqual([attachment])
    expect(replies('b')[0].inputMessageIds).toContain(feedback.id)
    expect(manager.statuses(room.id).b.queued).toBe(0)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('folds a handoff received during startup into the first send', async () => {
    const initial = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    const { send, replies } = setup()
    send('Implement the form', ['b'])
    send('Review the API', ['a'])
    await settle()
    const [worker, lead] = mocks.connectors
    complete(lead, 'API reviewed\n→ @gpt: Use the revised API')
    await settle()
    initial.resolve('before')
    await settle()
    expect(worker.steer).not.toHaveBeenCalled()
    expect(worker.send.mock.calls[0][0].text).toContain('Use the revised API')
    expect(replies('b')[0].inputMessageIds).toContain(replies('a')[0].id)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it.each([true, false])('serializes incoming feedback while an earlier acknowledgment is pending (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { send, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise).mockResolvedValue(true)
    const first = send('First correction', ['b'])
    const second = send('Second correction', ['b'], [attachment])
    await settle()
    expect(worker.steer).toHaveBeenCalledOnce()
    acknowledgment.resolve(accepted)
    await settle()
    expect(worker.steer).toHaveBeenCalledTimes(2)
    expect(worker.steer.mock.calls[1][0].text).toContain('Second correction')
    expect(worker.steer.mock.calls[1][0].text.includes('First correction')).toBe(!accepted)
    expect(worker.steer.mock.calls[1][0].images).toEqual([attachment])
    expect(replies('b')[0].inputMessageIds).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(replies('b')[0].prompt!.text.match(/First correction/g)).toHaveLength(1)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it.each([true, false])('settles an acknowledgment before starting follow-up work when the turn finishes first (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { send, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    send('Correction during the first turn', ['b'])
    await settle()
    complete(worker)
    await settle()
    send('Next request', ['b'])
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
    acknowledgment.resolve(accepted)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
    const followup = worker.send.mock.calls[1][0].text
    expect(followup).toContain('Next request')
    expect(followup.includes('Correction during the first turn')).toBe(!accepted)
    expect(replies('b')[0].prompt!.text.includes('Correction during the first turn')).toBe(accepted)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('retries feedback when the provider supplies its turn ID (acknowledgment still pending: %s)', async (pendingAck) => {
    const acknowledgment = deferred<boolean>()
    const { send } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(pendingAck ? acknowledgment.promise : Promise.resolve(false)).mockResolvedValue(true)
    send('Correction during provider startup', ['b'])
    await settle()
    worker.report({ t: 'turn-ref', start: 'native-turn-1' })
    if (pendingAck) acknowledgment.resolve(false)
    await settle()
    expect(worker.steer).toHaveBeenCalledTimes(2)
    expect(worker.steer.mock.calls[1][0].text).toContain('Correction during provider startup')
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('delivers feedback while waiting for approval without answering the approval', async () => {
    const { send, manager, room, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockResolvedValue(true)
    worker.report({ t: 'status', status: 'waiting' })
    worker.report({ t: 'approval', requestId: 'approval-1', toolName: 'shell', input: {}, canAlways: false })
    send('Here is additional context', ['b'])
    await settle()
    expect(worker.steer).toHaveBeenCalledOnce()
    expect(worker.answer).not.toHaveBeenCalled()
    expect(manager.statuses(room.id).b.status).toBe('waiting')
    expect(replies('b')[0].blocks).toContainEqual(expect.objectContaining({ kind: 'approval', status: 'pending' }))
  })

  it('keeps the handoff identity and relay limit when steering fails', async () => {
    const { send, replies } = setup({ maxHops: 1 })
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    complete(lead, 'Review ready\n→ @gpt: Finish the reviewed work')
    await settle()
    expect(worker.steer).toHaveBeenCalledOnce()
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
    expect(worker.send.mock.calls[1][0].text).toContain('Finish the reviewed work')
    expect(replies('b')[1].hop).toBe(1)
    complete(worker, 'Reviewed work done\n→ @claude: Another task')
    await settle()
    expect(lead.send).toHaveBeenCalledOnce()
  })

  it('preserves the relay limit when a handoff joins an active turn', async () => {
    const { send, replies } = setup({ maxHops: 1 })
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockResolvedValue(true)
    complete(lead, 'Review ready\n→ @gpt: Finish the reviewed work')
    await settle()
    expect(replies('b')[0].hop).toBe(1)
    complete(worker, 'Reviewed work done\n→ @claude: Another task')
    await settle()
    expect(lead.send).toHaveBeenCalledOnce()
  })

  it('settles late handoff acceptance before computing the outgoing relay limit', async () => {
    const acknowledgment = deferred<boolean>()
    const { send, replies } = setup({ maxHops: 1 })
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    complete(lead, 'Review ready\n→ @gpt: Finish the reviewed work')
    await settle()
    complete(worker, 'Reviewed work done\n→ @claude: Another task')
    await settle()
    expect(lead.send).toHaveBeenCalledOnce()
    acknowledgment.resolve(true)
    await settle()
    expect(replies('b')[0].hop).toBe(1)
    expect(lead.send).toHaveBeenCalledOnce()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it.each([true, false])('preserves the final outgoing relay when completion races acknowledgment (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { send } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    complete(lead, 'Review ready\n→ @gpt: Finish the reviewed work')
    await settle()
    complete(worker, 'Reviewed work done\n→ @claude: Integrate the completed files')
    await settle()
    expect(lead.send).toHaveBeenCalledOnce()
    acknowledgment.resolve(accepted)
    await settle()
    expect(lead.send).toHaveBeenCalledTimes(2)
    expect(lead.send.mock.calls[1][0].text).toContain('Integrate the completed files')
    expect(worker.send).toHaveBeenCalledTimes(accepted ? 1 : 2)
  })

  it('ignores an acknowledgment from a disposed runtime', async () => {
    const acknowledgment = deferred<boolean>()
    const { manager, send, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    send('Late correction', ['b'])
    await settle()
    manager.disposeAll()
    acknowledgment.resolve(true)
    await settle()
    expect(replies('b')[0].prompt!.text).not.toContain('Late correction')
    expect(worker.send).toHaveBeenCalledOnce()
    expect(manager.busyRooms()).toEqual([])
  })

  it('falls back to a queued turn when the connector has no live-input capability', async () => {
    const { send } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    Reflect.deleteProperty(worker, 'steer')
    complete(lead, 'Review ready\n→ @gpt: Apply the review')
    await settle()
    send('Also keep the public API', ['b'])
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
    expect(worker.send.mock.calls[1][0].text).toContain('Apply the review')
    expect(worker.send.mock.calls[1][0].text).toContain('Also keep the public API')
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
  })

  it('keeps feedback queued when live input throws synchronously', async () => {
    const { send } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockImplementationOnce(() => { throw new Error('Stream closed') })
    send('Keep this feedback', ['b'])
    await settle()
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
    expect(worker.send.mock.calls[1][0].text).toContain('Keep this feedback')
  })

  it('releases a stopped in-flight handoff and ignores its later acknowledgment', async () => {
    const acknowledgment = deferred<boolean>()
    const { manager, room, send, replies } = setup()
    send('Work together', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    complete(lead, 'Review ready\n→ @gpt: Apply the review')
    await settle()
    manager.stop(room.id, 'b')
    await settle()
    acknowledgment.resolve(true)
    await settle()
    expect(replies('a')[0].handoffDone).toBe(false)
    expect(replies('a')[0].deliveredTo).not.toContain('b')
    expect(worker.send).toHaveBeenCalledOnce()
    send('Resume the reviewed task', ['b'])
    await settle()
    expect(worker.send.mock.calls[1][0].text).toContain('Apply the review')
    expect(replies('a')[0].handoffDone).toBe(true)
  })

  it('replays unacknowledged input once when a provider session is restarted', async () => {
    const acknowledgment = deferred<boolean>()
    const { send, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    const feedback = send('Correction to preserve', ['b'])
    await settle()
    worker.report({ t: 'session-invalid' })
    await settle()
    const restarted = mocks.connectors[1]
    expect(restarted.send).toHaveBeenCalledOnce()
    expect(restarted.send.mock.calls[0][0].text).toContain('Original task')
    expect(restarted.send.mock.calls[0][0].text.match(/Correction to preserve/g)).toHaveLength(1)
    acknowledgment.resolve(false)
    await settle()
    expect(feedback.deliveredTo).toContain('b')
    expect(replies('b')).toHaveLength(1)
    complete(restarted)
    await settle()
    expect(restarted.send).toHaveBeenCalledOnce()
  })

  it.each([true, false])('ignores late acknowledgment after Stop and allows a fresh user request (%s)', async (accepted) => {
    const acknowledgment = deferred<boolean>()
    const { manager, room, send, replies } = setup()
    send('Original task', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    worker.steer.mockReturnValueOnce(acknowledgment.promise)
    const feedback = send('Interrupted correction', ['b'])
    await settle()
    manager.stop(room.id, 'b')
    await settle()
    expect(feedback.deliveredTo).not.toContain('b')
    send('Resume with the corrections', ['b'])
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
    expect(worker.send.mock.calls[1][0].text).toContain('Interrupted correction')
    acknowledgment.resolve(accepted)
    await settle()
    expect(replies('b')[0].prompt!.text).not.toContain('Interrupted correction')
    expect(feedback.deliveredTo).toContain('b')
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledTimes(2)
  })
})

describe('RoomManager delegated turns', () => {
  it('validates and passes one-turn overrides without changing saved settings or the next user turn', async () => {
    const { manager, room, send, replies } = setup()
    const saved = { ...room.members[1].settings }
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], 'Prepared work\n→ @gpt [model=delegated-model effort=low]: Implement worker.ts')
    await settle()
    const worker = mocks.connectors[1]
    expect(worker.send.mock.calls[0][0]).toMatchObject({ overrides: { model: 'delegated-model', effort: 'low' } })
    expect(room.members[1].settings).toEqual(saved)
    expect(replies('b')[0].execution).toMatchObject({ model: 'delegated-model', effort: 'low', delegated: true })
    manager.updateMember(room.id, 'b', { model: 'user-model', effort: 'xhigh' })
    complete(worker)
    await settle()
    send('Next user task', ['b'])
    await settle()
    expect(worker.send.mock.calls[1][0].overrides).toBeUndefined()
    expect(replies('b')[1].execution).toMatchObject({ model: 'user-model', effort: 'xhigh', delegated: false })
  })

  it.each([
    'model=unknown-model effort=low',
    'model=delegated-model effort=xhigh',
    'model=delegated-model',
    'model=delegated-model effort=low permissionMode=bypassPermissions'
  ])('blocks unsupported settings (%s) for automatic and manual handoff', async (settings) => {
    const { manager, room, send, replies } = setup()
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], `Prepared work\n→ @gpt [${settings}]: Implement worker.ts`)
    await settle()
    const reply = replies('a')[0]
    expect(reply.handoff?.error).toBeTruthy()
    expect(mocks.connectors).toHaveLength(1)
    expect(() => manager.continueHandoff(room.id, reply.id)).toThrow()
  })

  it('revalidates manual delegation against the current account catalog', async () => {
    const { manager, room, send, replies, accounts } = setup({ autoRelay: false })
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], 'Prepared work\n→ @gpt [model=delegated-model effort=low]: Implement worker.ts')
    await settle()
    const reply = replies('a')[0]
    expect(reply.handoff?.error).toBeUndefined()
    accounts.meta.get('acc-b')!.models = []
    expect(() => manager.continueHandoff(room.id, reply.id)).toThrow(/model|refresh|available/i)
    expect(mocks.connectors).toHaveLength(1)
  })

  it('allows a previously unavailable model after refreshing the account catalog', async () => {
    const { manager, room, send, replies, accounts } = setup()
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], 'Prepared work\n→ @gpt [model=new-model effort=low]: Implement worker.ts')
    await settle()
    const reply = replies('a')[0]
    expect(reply.handoff?.error).toBeTruthy()
    accounts.meta.get('acc-b')!.models.push({ id: 'new-model', label: 'New model', efforts: ['low'], isDefault: false })
    expect(() => manager.continueHandoff(room.id, reply.id)).not.toThrow()
    await settle()
    expect(mocks.connectors[1].send.mock.calls[0][0].overrides).toEqual({ model: 'new-model', effort: 'low' })
    expect(reply.handoff?.error).toBeUndefined()
  })

  it('revalidates inherited settings before starting a queued delegated turn', async () => {
    const { manager, room, send } = setup()
    manager.updateMember(room.id, 'b', { model: 'delegated-model', effort: 'low' })
    send('Worker task already running', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    send('Lead task', ['a'])
    await settle()
    complete(mocks.connectors[1], 'Prepared work\n→ @gpt [effort=medium]: Implement worker.ts')
    await settle()
    manager.updateMember(room.id, 'b', { model: 'saved-model', effort: 'high' })
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('keeps queued handoff tasks and their overrides in separate turns even when user feedback arrives', async () => {
    const { send } = setup()
    send('Worker task already running', ['b'])
    await settle()
    const worker = mocks.connectors[0]
    send('First lead task', ['a'])
    await settle()
    const lead = mocks.connectors[1]
    complete(lead, 'Task one ready\n→ @gpt [model=delegated-model effort=low]: Implement first-worker.ts')
    await settle()
    send('Second lead task', ['a'])
    await settle()
    complete(lead, 'Task two ready\n→ @gpt [model=saved-model effort=high]: Review second-worker.ts')
    await settle()
    worker.steer.mockResolvedValue(true)
    send('Keep changes small', ['b'])
    await settle()
    const feedback = worker.steer.mock.calls.at(-1)![0].text
    expect(feedback).toContain('Keep changes small')
    expect(feedback).not.toContain('first-worker.ts')
    expect(feedback).not.toContain('second-worker.ts')

    complete(worker)
    await settle()
    const first = worker.send.mock.calls[1][0]
    expect(first.text).toContain('first-worker.ts')
    expect(first.text).not.toContain('second-worker.ts')
    expect(first.overrides).toEqual({ model: 'delegated-model', effort: 'low' })
    complete(worker)
    await settle()
    const second = worker.send.mock.calls[2][0]
    expect(second.text).toContain('second-worker.ts')
    expect(second.text).not.toContain('first-worker.ts')
    expect(second.overrides).toEqual({ model: 'saved-model', effort: 'high' })
  })

  it('preserves the temporary settings when retrying a delegated turn', async () => {
    const { manager, room, send, replies } = setup()
    send('Delegate work')
    await settle()
    complete(mocks.connectors[0], 'Prepared work\n→ @gpt [model=delegated-model effort=low]: Implement worker.ts')
    await settle()
    const worker = mocks.connectors[1]
    complete(worker, 'Could not finish', false)
    await settle()
    await manager.retry(room.id, replies('b')[0].id)
    await settle()
    expect(worker.send.mock.calls[1][0].overrides).toEqual({ model: 'delegated-model', effort: 'low' })
    expect(room.members[1].settings).toMatchObject({ model: 'saved-model', effort: 'high' })
  })

  it('retries with successfully steered text and attachments included exactly once', async () => {
    const { manager, room, send, replies } = setup({ kind: 'claude', members: [member('a', 'claude')] })
    send('Original task')
    await settle()
    const connector = mocks.connectors[0]
    connector.steer.mockResolvedValue(true)
    send('Keep the existing API shape', ['a'], [attachment])
    await settle()
    complete(connector, 'Could not finish', false)
    await settle()
    const reply = replies('a')[0]
    await manager.retry(room.id, reply.id)
    await settle()
    expect(connector.forkAt).toHaveBeenCalledOnce()
    const retried = connector.send.mock.calls[1][0]
    expect(retried.text).toContain('Original task')
    expect(retried.text.match(/Keep the existing API shape/g)).toHaveLength(1)
    expect(retried.images).toEqual([attachment])
  })

  it('edits feedback by removing the earlier reply that consumed it and replaying the original task', async () => {
    const { manager, room, send, replies } = setup({ kind: 'claude', members: [member('a', 'claude')] })
    const original = send('Original task')
    await settle()
    const connector = mocks.connectors[0]
    connector.steer.mockResolvedValue(true)
    const feedback = send('Use the old API')
    await settle()
    complete(connector)
    await settle()
    const oldReply = replies('a')[0]
    expect(room.messages.indexOf(oldReply)).toBeLessThan(room.messages.indexOf(feedback))
    await manager.editMessage(room.id, feedback.id, 'Use the revised API', false)
    await settle()
    expect(room.messages.some((m) => m.id === oldReply.id || m.id === feedback.id)).toBe(false)
    expect(room.messages.some((m) => m.id === original.id)).toBe(true)
    expect(connector.forkAt).toHaveBeenCalledWith(undefined)
    const revised = connector.send.mock.calls[1][0].text
    expect(revised).toContain('Original task')
    expect(revised).toContain('Use the revised API')
    expect(revised).not.toContain('Use the old API')
  })
})

describe('RoomManager unrelayed handoffs', () => {
  it.each<[string, Partial<Room>]>([
    ['automatic relay disabled', { autoRelay: false }],
    ['recipient unticked', { active: ['a'] }],
    ['hop limit reached', { maxHops: 0 }]
  ])('delivers the original request when the user addresses its recipient: %s', async (_label, settings) => {
    const { manager, room, send, replies } = setup(settings)
    send('Plan the work')
    await settle()
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    const handoff = replies('a')[0]
    expect(handoff.handoffDone).not.toBe(true)
    send('Please do what Claude asked', ['b'])
    await settle()
    const worker = mocks.connectors[1]
    expect(worker.send.mock.calls[0][0].text).toContain('Implement worker.ts with retries')
    expect(handoff.handoffDone).toBe(true)
    expect(handoff.deliveredTo).toContain('b')
    manager.continueHandoff(room.id, handoff.id)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('includes unrelayed requests when steering a running recipient', async () => {
    const { send, replies, host } = setup({ autoRelay: false })
    send('Inspect the project', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    worker.steer.mockResolvedValue(true)
    complete(lead, 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    send('Also do what Claude asked', ['b'])
    await settle()
    expect(worker.steer.mock.calls[0][0].text).toContain('Implement worker.ts with retries')
    expect(replies('a')[0].handoffDone).toBe(true)
    expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.objectContaining({ id: replies('a')[0].id, handoffDone: true }) }))
  })

  it('leaves an unrelayed request available after a rejected steer, then delivers it next turn', async () => {
    const { send, replies } = setup({ autoRelay: false })
    send('Inspect the project', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    complete(lead, 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    send('Also do what Claude asked', ['b'])
    await settle()
    expect(replies('a')[0].handoffDone).not.toBe(true)
    expect(replies('a')[0].deliveredTo).not.toContain('b')
    complete(worker)
    await settle()
    expect(worker.send.mock.calls[1][0].text).toContain('Implement worker.ts with retries')
    expect(replies('a')[0].handoffDone).toBe(true)
  })

  it('releases a cancelled queued handoff so a later user message can deliver it', async () => {
    const { manager, room, send, replies } = setup()
    send('Inspect the project', ['a', 'b'])
    await settle()
    const [lead, worker] = mocks.connectors
    complete(lead, 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    expect(replies('a')[0].handoffDone).toBe(true)
    manager.stop(room.id, 'b')
    await settle()
    expect(replies('a')[0].handoffDone).toBe(false)
    send('Now do what Claude asked', ['b'])
    await settle()
    expect(worker.send.mock.calls[1][0].text).toContain('Implement worker.ts with retries')
    expect(replies('a')[0].handoffDone).toBe(true)
  })

  it('releases input when stopped before the initial snapshot allows delivery', async () => {
    const { manager, room, send, replies } = setup({ autoRelay: false })
    send('Plan the work')
    await settle()
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    const initial = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(initial.promise)
    send('Do what Claude asked', ['b'])
    manager.stop(room.id, 'b')
    await settle()
    initial.resolve('baseline')
    await settle()
    const handoff = replies('a')[0]
    expect(handoff.handoffDone).not.toBe(true)
    expect(handoff.deliveredTo).not.toContain('b')
    expect(mocks.connectors[1].send).not.toHaveBeenCalled()
    send('Continue with Claude’s request', ['b'])
    await settle()
    expect(mocks.connectors[1].send.mock.calls[0][0].text).toContain('Implement worker.ts with retries')
    expect(handoff.handoffDone).toBe(true)
  })

  it('delivers a cancelled planned relay immediately, without its snapshot later undoing delivery', async () => {
    const { manager, room, send, replies } = setup()
    send('Plan the work')
    await settle()
    const ending = deferred<string>()
    vi.mocked(snapshot).mockReturnValueOnce(ending.promise)
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    manager.stop(room.id, 'a')
    send('Now do what Claude asked', ['b'])
    await settle()
    const worker = mocks.connectors[1]
    expect(worker.send.mock.calls[0][0].text).toContain('Implement worker.ts with retries')
    const handoff = replies('a')[0]
    expect(handoff.handoffDone).toBe(true)
    ending.resolve('after')
    await settle()
    expect(handoff.handoffDone).toBe(true)
    manager.continueHandoff(room.id, handoff.id)
    complete(worker)
    await settle()
    expect(worker.send).toHaveBeenCalledOnce()
  })

  it('replays a previously delivered request when the provider session must be restarted', async () => {
    const { send, replies } = setup({ autoRelay: false })
    send('Plan the work')
    await settle()
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt: Implement worker.ts with retries')
    await settle()
    send('Do what Claude asked', ['b'])
    await settle()
    expect(replies('a')[0].handoffDone).toBe(true)
    mocks.connectors[1].report({ t: 'session-invalid' })
    await settle()
    expect(mocks.connectors[2].send.mock.calls[0][0].text).toContain('Implement worker.ts with retries')
  })

  it('relays bracket labels as task text instead of invalid settings', async () => {
    const { send, replies } = setup()
    send('Plan the work')
    await settle()
    complete(mocks.connectors[0], 'Plan ready\n→ @gpt [urgent]: Implement worker.ts')
    await settle()
    const handoff = replies('a')[0]
    expect(handoff.handoff?.error).toBeUndefined()
    expect(handoff.handoff?.text).toBe('[urgent]: Implement worker.ts')
    expect(mocks.connectors[1]?.send.mock.calls[0][0].text).toContain('[urgent]: Implement worker.ts')
    expect(handoff.handoffDone).toBe(true)
  })
})

describe('RoomManager shared file undo', () => {
  beforeEach(() => {
    let number = 0
    vi.mocked(snapshot).mockImplementation(async () => `tree-${++number}`)
  })

  it('disallows whole-turn undo for both turns when agents overlapped in one folder', async () => {
    const { manager, room, send, replies } = setup()
    send('Work in parallel', ['a', 'b'])
    await settle()
    complete(mocks.connectors[0])
    complete(mocks.connectors[1])
    await settle()
    for (const memberId of ['a', 'b']) {
      await expect(manager.undoTurn(room.id, replies(memberId)[0].id)).rejects.toThrow(/concurrent|overlap|shared|other agents/i)
    }
    expect(restoreTree).not.toHaveBeenCalled()
    for (const connector of mocks.connectors) expect(connector.undoFiles).not.toHaveBeenCalled()
  })

  it('disallows undo while another agent is still running in the same folder', async () => {
    const { manager, room, send, replies } = setup()
    send('First task', ['a'])
    await settle()
    complete(mocks.connectors[0])
    await settle()
    send('Second task', ['b'])
    await settle()
    await expect(manager.undoTurn(room.id, replies('a')[0].id)).rejects.toThrow(/working|finish|running|busy/i)
    expect(restoreTree).not.toHaveBeenCalled()
  })

  it('also disallows whole-turn undo when another room used the same folder concurrently', async () => {
    const { manager, room, send, replies, store } = setup()
    const other: Room = { ...room, id: 'room-2', kind: 'codex', members: [room.members[1]], messages: [], sessions: {} }
    store.put(other)
    send('First room task', ['a'])
    manager.send(other.id, { text: 'Other room task', to: ['b'], attachments: [] })
    await settle()
    complete(mocks.connectors[0])
    complete(mocks.connectors[1])
    await settle()
    await expect(manager.undoTurn(room.id, replies('a')[0].id)).rejects.toThrow(/other agents/i)
    await expect(manager.undoTurn(other.id, other.messages.find((m) => m.author === 'b')!.id)).rejects.toThrow(/other agents/i)
    expect(restoreTree).not.toHaveBeenCalled()
  })

  it('allows undo for concurrent agents working in separate worktrees', async () => {
    const members = [member('a', 'claude'), member('b', 'codex')].map((m) => ({
      ...m, worktree: { path: `/worktrees/${m.id}`, branch: `task/${m.id}`, base: 'base' }
    }))
    const { manager, room, send, replies } = setup({ isolation: true, members })
    send('Work in parallel', ['a', 'b'])
    await settle()
    complete(mocks.connectors[0])
    complete(mocks.connectors[1])
    await settle()
    for (const memberId of ['a', 'b']) {
      const reply = replies(memberId)[0]
      await expect(manager.undoTurn(room.id, reply.id)).resolves.toBe('Put back 1 file')
      expect(restoreTree).toHaveBeenCalledWith(`/worktrees/${memberId}`, reply.snapshot?.before, reply.snapshot?.after)
      expect(reply.undone).toBe(true)
    }
  })
})
