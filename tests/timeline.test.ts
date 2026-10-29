import { describe, expect, it } from 'vitest'
import { buildTimeline, liveStep, planItems, reuseItems, segmentParts, type AgentItem, type TimelineItem } from '../src/renderer/src/lib/timeline'
import { paneMessages } from '../src/renderer/src/lib/agentPanes'
import type { Block, Message } from '../src/shared/types'

const s = (n: number): number => 1_000_000 + n * 1000

const user = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, author: 'user', createdAt: at, text: id, blocks: [], status: 'done', ...extra })
const agent = (id: string, author: string, at: number, blocks: Block[], extra: Partial<Message> = {}): Message => ({ id, author, createdAt: at, text: '', blocks, status: 'done', ...extra })
const tool = (id: string, at: number | undefined, name = 'Bash', input: unknown = { command: 'ls' }): Block => ({ kind: 'tool', id, at, name, input, status: 'done' })
const text = (id: string, at: number | undefined, body = id): Block => ({ kind: 'text', id, at, text: body })
const todos = (id: string, at: number, ...statuses: string[]): Block =>
  tool(id, at, 'TodoWrite', { todos: statuses.map((status, i) => ({ content: `Step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status })) })

/** "u1", "a1#0" (segment 0 of a1), "a1#1"… */
const shape = (items: TimelineItem[]): string[] => items.map((item) => item.kind === 'user' ? item.message.id : `${item.message.id}#${item.segment}`)
const agentItems = (items: TimelineItem[]): AgentItem[] => items.filter((item): item is AgentItem => item.kind === 'agent')
const blockIds = (item: AgentItem): string[] => item.blocks.map((b) => b.id)

describe('conversation timeline', () => {
  it('keeps a turn whole when nothing was sent while it ran', () => {
    const items = buildTimeline([user('u1', s(0)), agent('a1', 'claude', s(1), [text('b1', s(2)), tool('b2', s(3))]), user('u2', s(10))])
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2'])
    const [turn] = agentItems(items)
    expect(turn).toMatchObject({ isFirst: true, isLast: true })
    expect(blockIds(turn)).toEqual(['b1', 'b2'])
  })

  it('places a message sent mid-run where it was sent and continues the turn below it', () => {
    const messages = [
      user('u1', s(0)),
      agent('a1', 'claude', s(1), [
        { kind: 'thinking', id: 'b1', at: s(2), text: 'Look at usage.ts' },
        todos('b2', s(3), 'in_progress', 'pending'),
        tool('b3', s(5)),
        text('b5', s(9)),
        todos('b6', s(11), 'completed', 'in_progress'),
        tool('b7', s(35), 'Bash', { command: 'npm test' }),
        tool('b8', s(38), 'Edit', { file_path: '/p/README.md', old_string: 'a', new_string: 'b' }),
        text('b10', s(42))
      ]),
      user('u2', s(30))
    ]
    const items = buildTimeline(messages)
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'a1#1'])
    const [before, after] = agentItems(items)
    expect(blockIds(before)).toEqual(['b1', 'b2', 'b3', 'b5', 'b6'])
    expect(blockIds(after)).toEqual(['b7', 'b8', 'b10'])
    expect(before).toMatchObject({ isFirst: true, isLast: false, plan: undefined })
    expect(after).toMatchObject({ isFirst: false, isLast: true })
    expect(after.plan?.block.id).toBe('b6')
    expect(after.plan?.carried).toBe(true)
    expect(after.plan?.items.map((i) => i.status)).toEqual(['completed', 'in_progress'])
  })

  it('does not carry a plan that was updated after the latest message', () => {
    const items = buildTimeline([user('u1', s(0)), agent('a1', 'claude', s(1), [todos('p1', s(2), 'pending'), tool('t', s(20)), todos('p2', s(21), 'completed')]), user('u2', s(10))])
    const last = agentItems(items).at(-1)!
    expect(last.plan).toMatchObject({ carried: false })
    expect(last.plan?.block.id).toBe('p2')
  })

  it('gives a running turn an empty trailing part after your newest message for the plan and status', () => {
    const messages = [
      user('u1', s(0)),
      agent('a1', 'claude', s(1), [todos('p', s(2), 'in_progress', 'pending'), tool('t', s(4))], { status: 'streaming' }),
      user('u2', s(30))
    ]
    const items = buildTimeline(messages)
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'a1#1'])
    const [first, trailing] = agentItems(items)
    expect(first.plan).toBeUndefined()
    expect(trailing.blocks).toEqual([])
    expect(trailing).toMatchObject({ isFirst: false, isLast: true, plan: { carried: true } })
  })

  it('drops empty middle parts but keeps the first part of a finished turn', () => {
    const items = buildTimeline([user('u1', s(0)), agent('a1', 'claude', s(1), [tool('t1', s(2)), tool('t2', s(40))]), user('u2', s(10)), user('u3', s(20))])
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'u3', 'a1#2'])
  })

  it('starts a running turn below your message when it had produced nothing before it', () => {
    const items = buildTimeline([user('u1', s(0)), agent('a1', 'claude', s(1), [], { status: 'streaming' }), user('u2', s(5))])
    expect(shape(items)).toEqual(['u1', 'u2', 'a1#1'])
    expect(agentItems(items)[0]).toMatchObject({ isFirst: true, isLast: true })
  })

  it('continues each of several running agents below your message', () => {
    const messages = [
      user('u1', s(0), { to: ['claude', 'gpt'] }),
      agent('a1', 'claude', s(1), [tool('c1', s(2)), tool('c2', s(12))], { status: 'streaming' }),
      agent('a2', 'gpt', s(1), [tool('g1', s(3)), tool('g2', s(14))], { status: 'streaming' }),
      user('u2', s(10), { to: ['claude', 'gpt'] })
    ]
    const items = buildTimeline(messages)
    expect(shape(items)).toEqual(['u1', 'a1#0', 'a2#0', 'u2', 'a1#1', 'a2#1'])
    expect(agentItems(items).map(blockIds)).toEqual([['c1'], ['g1'], ['c2'], ['g2']])
  })

  it('leaves queued messages out and places a dispatched one at the time it was sent', () => {
    const messages = [
      user('u1', s(0)),
      agent('a1', 'claude', s(1), [tool('t1', s(2))]),
      user('queued', s(5), { queued: true }),
      user('u2', s(6), { sentAt: s(20) }),
      agent('a2', 'claude', s(20), [text('t2', s(21))])
    ]
    expect(shape(buildTimeline(messages))).toEqual(['u1', 'a1#0', 'u2', 'a2#0'])
  })

  it('does not split a turn at a queued message sent while it ran', () => {
    const messages = [user('u1', s(0)), agent('a1', 'claude', s(1), [tool('t1', s(2)), tool('t2', s(9))], { status: 'streaming' }), user('q', s(5), { queued: true })]
    expect(shape(buildTimeline(messages))).toEqual(['u1', 'a1#0'])
  })

  it('keeps another agent\'s hand-off whole in an agent panel, while its own turn still splits', () => {
    const messages = [
      user('u1', s(0), { to: ['a', 'b'] }),
      agent('A1', 'a', s(1), [tool('ta1', s(2)), tool('ta2', s(15))]),
      agent('B1', 'b', s(1), [tool('tb1', s(2)), text('tb2', s(20))], { handoff: { to: 'a', text: 'over to you' } }),
      user('u2', s(10), { to: ['a'] })
    ]
    const pane = paneMessages(messages, 'a')
    expect(shape(buildTimeline(pane, 'a'))).toEqual(['u1', 'A1#0', 'B1#0', 'u2', 'A1#1'])
    expect(blockIds(agentItems(buildTimeline(pane, 'a')).find((item) => item.message.id === 'B1')!)).toEqual(['tb1', 'tb2'])
    // The shared chat still shows everyone's work around the message, in time order.
    expect(shape(buildTimeline(messages))).toEqual(['u1', 'A1#0', 'B1#0', 'u2', 'A1#1', 'B1#1'])
  })

  it('renders saved turns without block times exactly as before', () => {
    const messages = [user('u1', s(0)), agent('a1', 'claude', s(1), [tool('t1', undefined), text('x', undefined)]), user('u2', s(30)), agent('a2', 'claude', s(31), [text('y', undefined)])]
    const items = buildTimeline(messages)
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'a2#0'])
    expect(blockIds(agentItems(items)[0])).toEqual(['t1', 'x'])
  })

  it('puts your message first when a turn starts in the same millisecond, and keeps array order otherwise', () => {
    const items = buildTimeline([agent('a0', 'gpt', s(0), [text('g', s(0))]), user('u1', s(0)), agent('a1', 'claude', s(0), [text('c', s(0))]), agent('a2', 'gpt', s(0), [])])
    expect(shape(items)).toEqual(['u1', 'a0#0', 'a1#0', 'a2#0'])
  })

  it('places each block in the part it was created in, even after a late approval', () => {
    const approval: Block = { kind: 'approval', id: 'ap', at: s(12), requestId: 'r', toolName: 'Bash', input: {}, canAlways: false, status: 'allowed' }
    const items = buildTimeline([user('u1', s(0)), agent('a1', 'claude', s(1), [tool('t1', s(2)), approval, text('x', s(8)), text('y', s(15))]), user('u2', s(10))])
    expect(agentItems(items).map(blockIds)).toEqual([['t1', 'x'], ['ap', 'y']])
  })

  it('keeps parallel tools above your message when one asks for permission after it', () => {
    const approval: Block = { kind: 'approval', id: 'ap', at: s(30), requestId: 'r', toolName: 'Bash', input: {}, canAlways: false, status: 'pending' }
    const items = buildTimeline([
      user('u1', s(0)),
      agent('a1', 'claude', s(1), [tool('A', s(20)), approval, tool('B', s(20)), tool('C', s(21)), text('D', s(31))], { status: 'streaming' }),
      user('u2', s(25))
    ])
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'a1#1'])
    expect(agentItems(items).map(blockIds)).toEqual([['A', 'B', 'C'], ['ap', 'D']])
  })
})

describe('reusing unchanged rows', () => {
  it('keeps item objects whose content did not change', () => {
    const u1 = user('u1', s(0))
    const u2 = user('u2', s(4))
    const done = agent('a1', 'claude', s(1), [text('t', s(2))])
    const first = buildTimeline([u1, done])
    const live = agent('a2', 'claude', s(5), [text('x', s(6))], { status: 'streaming' })
    const second = reuseItems(first, buildTimeline([u1, done, u2, live]))
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    const third = reuseItems(second, buildTimeline([u1, done, u2, { ...live, blocks: [...live.blocks, text('z', s(7))] }]))
    expect(third[1]).toBe(first[1])
    expect(third[2]).toBe(second[2])
    expect(third[3]).not.toBe(second[3])
  })
})

describe('plan items and segment parts', () => {
  it('reads Claude todos and Codex plan steps', () => {
    expect(planItems(todos('p', 0, 'completed', 'in_progress', 'pending')).map((i) => [i.text, i.status])).toEqual([['Step 1', 'completed'], ['Step 2', 'in_progress'], ['Step 3', 'pending']])
    expect(planItems(tool('p', 0, 'Plan', { items: [{ text: 'Sketch', status: 'completed' }, { text: 'Build', status: 'inProgress' }, { step: 'Ship' }] })).map((i) => [i.text, i.status]))
      .toEqual([['Sketch', 'completed'], ['Build', 'in_progress'], ['Ship', 'pending']])
    expect(planItems(tool('p', 0, 'Bash'))).toEqual([])
    expect(planItems(tool('p', 0, 'TodoWrite', { todos: 'nope' }))).toEqual([])
  })

  it('ignores an empty plan when choosing the one to show', () => {
    const items = buildTimeline([agent('a1', 'claude', s(1), [todos('p1', s(2), 'pending'), tool('p2', s(3), 'TodoWrite', { todos: [] })])])
    expect(agentItems(items)[0].plan?.block.id).toBe('p1')
  })

  it('folds consecutive thinking and tool steps and keeps text, approvals and errors apart', () => {
    const blocks: Block[] = [
      { kind: 'thinking', id: 'th', text: 'hmm' },
      tool('t1', 1),
      tool('t2', 2),
      text('x', 3),
      text('blank', 4, '  '),
      tool('t3', 5),
      { kind: 'approval', id: 'ap', requestId: 'r', toolName: 'Bash', input: {}, canAlways: false, status: 'pending' },
      tool('t4', 6),
      { kind: 'error', id: 'err', text: 'boom' }
    ]
    expect(segmentParts(blocks).map((p) => p.kind === 'activity' ? p.blocks.map((b) => b.id).join('+') : `${p.kind}:${p.key}`))
      .toEqual(['th+t1+t2', 'text:x', 't3', 'approval:ap', 't4', 'error:err'])
  })

  it('counts plan updates in the row they sit in but never shows one on its own', () => {
    const blocks: Block[] = [text('a', 1), todos('p1', 2, 'pending'), text('b', 3), tool('t1', 4), todos('p2', 5, 'completed'), text('c', 6)]
    expect(segmentParts(blocks).map((p) => p.kind === 'activity' ? p.blocks.map((b) => b.id).join('+') : `${p.kind}:${p.key}`))
      .toEqual(['text:a', 'text:b', 't1+p2', 'text:c'])
  })
})

describe('Claude Code task tools', () => {
  const create = (id: string, at: number, subject: string, n?: number, extra: Partial<Extract<Block, { kind: 'tool' }>> = {}): Block =>
    ({ kind: 'tool', id, at, name: 'TaskCreate', input: { subject, description: `${subject} in detail` }, status: 'done', output: n === undefined ? undefined : `Task #${n} created successfully: ${subject}`, ...extra })
  const update = (id: string, at: number, taskId: string, status: string): Block =>
    ({ kind: 'tool', id, at, name: 'TaskUpdate', input: { taskId, status }, status: 'done', output: `Updated task #${taskId} status` })
  const list = (id: string, at: number, output: string): Block => ({ kind: 'tool', id, at, name: 'TaskList', input: {}, status: 'done', output })
  const plan = (item: AgentItem | undefined) => item?.plan?.items.map((i) => `${i.text}:${i.status}`)

  it('builds the task list from TaskCreate and TaskUpdate calls', () => {
    const items = agentItems(buildTimeline([agent('a1', 'claude', s(1), [create('c1', s(2), 'Write notes', 1), create('c2', s(3), 'Check notes', 2), update('u1', s(4), '1', 'in_progress'), update('u2', s(5), '1', 'completed'), text('t', s(6))])]))
    expect(plan(items[0])).toEqual(['Write notes:completed', 'Check notes:pending'])
    expect(items[0].plan?.block.id).toBe('u2')
  })

  it('keeps tasks across turns of the same session and starts over in a new one', () => {
    const turn = { session: 'sess-1' }
    const items = agentItems(buildTimeline([
      agent('a1', 'claude', s(1), [create('c1', s(2), 'Write notes', 1), create('c2', s(3), 'Check notes', 2)]),
      user('u1', s(10)),
      agent('a2', 'claude', s(11), [update('u1', s(12), '2', 'in_progress')], { turn }),
      user('u2', s(20)),
      agent('a3', 'claude', s(21), [update('u2', s(22), '2', 'completed')], { turn: { session: 'sess-2' } })
    ]))
    // The first turn had no session id yet; it still belongs to the session that followed.
    expect(plan(items[1])).toEqual(['Write notes:pending', 'Check notes:in_progress'])
    // A new session has its own list, so an update for an unknown task shows nothing.
    expect(items[2].plan).toBeUndefined()
  })

  it('follows TaskList output, deletions, failed calls and calls still running', () => {
    const items = agentItems(buildTimeline([agent('a1', 'claude', s(1), [
      create('c1', s(2), 'One', 1),
      create('c2', s(3), 'Two', 2),
      create('c3', s(4), 'Three', 3),
      update('d', s(5), '3', 'deleted'),
      { kind: 'tool', id: 'bad', at: s(6), name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, status: 'error', isError: true, output: 'Task not found' },
      list('l', s(7), '#1 [in_progress] One\n#2 [completed] Two (renamed)'),
      create('c4', s(8), 'Four', undefined, { status: 'running' })
    ])]))
    expect(plan(items[0])).toEqual(['One:in_progress', 'Two (renamed):completed', 'Four:pending'])
  })

  it('carries the task list below a message sent before the latest update', () => {
    const items = buildTimeline([
      user('u1', s(0)),
      agent('a1', 'claude', s(1), [create('c1', s(2), 'Write notes', 1), update('x', s(3), '1', 'in_progress'), tool('t', s(40))], { status: 'streaming' }),
      user('u2', s(30))
    ])
    expect(shape(items)).toEqual(['u1', 'a1#0', 'u2', 'a1#1'])
    const last = agentItems(items).at(-1)!
    expect(last.plan).toMatchObject({ carried: true })
    expect(plan(last)).toEqual(['Write notes:in_progress'])
  })

  it('never shows task calls as rows of their own', () => {
    expect(segmentParts([create('c1', s(2), 'One', 1), update('u', s(3), '1', 'completed')])).toEqual([])
  })
})

describe('live activity rows', () => {
  const running = (id: string, at: number): Block => ({ kind: 'tool', id, at, name: 'Bash', input: { command: 'npm test' }, status: 'running' })
  const thinking: Block = { kind: 'thinking', id: 'th', at: 1, text: 'hmm' }

  it('keeps a tool live while its approval waits and while it runs afterwards', () => {
    const tool = running('t', 2)
    for (const status of ['pending', 'allowed'] as const) {
      const approval: Block = { kind: 'approval', id: 'ap', at: 3, requestId: 'r', toolName: 'Bash', input: {}, canAlways: false, status }
      const blocks = [thinking, tool, approval]
      const [group] = segmentParts(blocks)
      expect(group.kind === 'activity' && liveStep(group.blocks, true, approval)).toEqual({ kind: 'tool', block: tool })
    }
  })

  it('shows thinking only while it is the newest step, and nothing once the turn ends', () => {
    expect(liveStep([thinking], true, thinking)).toEqual({ kind: 'thinking', block: thinking })
    expect(liveStep([thinking], true, text('later', 5))).toBeUndefined()
    expect(liveStep([thinking, running('t', 2)], false, undefined)).toBeUndefined()
    expect(liveStep([tool('done', 2)], true, undefined)).toBeUndefined()
  })
})
