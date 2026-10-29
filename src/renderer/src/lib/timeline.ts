// Orders a conversation by time. An agent turn that kept working after you sent a
// message is split there, so your message sits where you sent it and the agent's later
// work continues below it.

import type { Block, Message } from '@shared/types'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanItem {
  text: string
  activeForm?: string
  status: PlanStatus
}

export interface PlanView {
  block: ToolBlock
  items: PlanItem[]
  /** The plan was last updated before the latest message that split this turn. */
  carried: boolean
}

export interface UserItem {
  kind: 'user'
  key: string
  message: Message
}

export interface AgentItem {
  kind: 'agent'
  key: string
  message: Message
  /** Which part of the turn this is: 0 before the first split, k after the k-th. */
  segment: number
  isFirst: boolean
  isLast: boolean
  blocks: Block[]
  /** Only on the last segment of a turn that has a plan. */
  plan?: PlanView
}

export type TimelineItem = UserItem | AgentItem

/** When a user message entered the conversation (a queued one: when it was dispatched). */
export function anchorOf(message: Message): number {
  return message.sentAt ?? message.createdAt
}

/** Claude Code's task list tools. The list lives in the agent's session, so later turns
 *  update tasks that earlier turns created. */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList'])

export function isPlanBlock(block: Block): block is ToolBlock {
  return block.kind === 'tool' && (block.name === 'TodoWrite' || block.name === 'Plan' || TASK_TOOLS.has(block.name))
}

function planStatus(raw: Record<string, unknown>): PlanStatus {
  const s = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''
  if (s === 'completed' || s === 'complete' || s === 'done' || raw.completed === true) return 'completed'
  if (s === 'in_progress' || s === 'inprogress' || s === 'in-progress' || s === 'active') return 'in_progress'
  return 'pending'
}

/** The items of a Claude TodoWrite (`todos`) or Codex Plan (`items`) block. */
export function planItems(block: Block): PlanItem[] {
  return isPlanBlock(block) ? planInputItems(block.name, block.input) : []
}

export function planInputItems(name: string, input: unknown): PlanItem[] {
  const fields = (input ?? {}) as Record<string, unknown>
  const list = name === 'TodoWrite' ? fields.todos : name === 'Plan' ? fields.items : undefined
  if (!Array.isArray(list)) return []
  return list.flatMap((raw): PlanItem[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const text = [item.content, item.text, item.step, item.activeForm].find((v): v is string => typeof v === 'string' && !!v.trim())
    if (!text) return []
    return [{ text, activeForm: typeof item.activeForm === 'string' ? item.activeForm : undefined, status: planStatus(item) }]
  })
}

/** An agent's task list by task id, in creation order. */
export type TaskBoard = Map<string, PlanItem>

const words = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** Applies one TaskCreate / TaskUpdate / TaskList call to the board. */
export function applyTask(board: TaskBoard, block: ToolBlock): void {
  if (!TASK_TOOLS.has(block.name) || block.status === 'error' || block.isError) return
  const input = (block.input ?? {}) as Record<string, unknown>
  if (block.name === 'TaskCreate') {
    const text = words(input.subject) || words(input.description)
    if (!text) return
    // "Task #3 created successfully: …" names the id; until the result arrives the call is its own key.
    const id = /Task #([^\s:]+)/.exec(block.output ?? '')?.[1] ?? `call:${block.id}`
    board.set(id, { text, activeForm: words(input.activeForm) || undefined, status: planStatus(input) })
  } else if (block.name === 'TaskUpdate') {
    const id = words(input.taskId)
    const task = board.get(id)
    if (!task) return
    if (input.status === 'deleted') board.delete(id)
    else board.set(id, { text: words(input.subject) || task.text, activeForm: words(input.activeForm) || task.activeForm, status: typeof input.status === 'string' ? planStatus(input) : task.status })
  } else {
    // "#1 [completed] Write notes", one line per task: the agent's own view of the list.
    const rows = [...(block.output ?? '').matchAll(/^#(\S+)\s+\[([\w-]+)\]\s+(.+)$/gm)]
    if (!rows.length) return
    const before = new Map(board)
    board.clear()
    for (const [, id, status, text] of rows) board.set(id, { text: text.trim(), activeForm: before.get(id)?.activeForm, status: planStatus({ status }) })
  }
}

/** Task boards per agent session. A turn whose session is not known yet continues the
 *  agent's current board, so the first turn's tasks carry over once the session id arrives. */
class TaskBoards {
  private current = new Map<string, { session: string; board: TaskBoard }>()

  for(message: Message): TaskBoard {
    const session = message.turn?.session ?? ''
    const known = this.current.get(message.author)
    if (known && (!session || session === known.session)) return known.board
    if (known && !known.session) {
      known.session = session
      return known.board
    }
    const next = { session, board: new Map() as TaskBoard }
    this.current.set(message.author, next)
    return next.board
  }
}

interface Placed {
  item: TimelineItem
  time: number
  /** Same-millisecond order: your message, then turns starting, then continuations. */
  rank: number
  order: number
  segment: number
}

function splitAgent(message: Message, anchors: number[], order: number, board: TaskBoard): Placed[] {
  const at = (b: Block): number => b.at ?? message.createdAt
  const live = message.status === 'streaming'
  const latest = message.blocks.reduce((max, b) => Math.max(max, at(b)), message.createdAt)
  const later = anchors.filter((a) => a > message.createdAt && (live || a < latest))
  const splits = [...new Set(later)]
  const segments: Block[][] = [[], ...splits.map(() => [])]
  // Each block goes to the part it was created in, by its own time. An approval is
  // inserted right after its tool but created when the agent asked, so one asked after
  // your message shows below it, where you are, and never drags earlier blocks along.
  for (const block of message.blocks) {
    const index = splits.findIndex((split) => at(block) <= split)
    segments[index === -1 ? splits.length : index].push(block)
  }
  const last = segments.length - 1
  const kept = segments
    .map((blocks, segment) => ({ blocks, segment }))
    .filter(({ blocks, segment }) => blocks.length > 0 || segments.length === 1 || (live && segment === last))

  // The card shows the list as the turn's latest plan call left it. Task tools build on
  // the session's board, which this turn's calls then advance for later turns.
  const planIndex = message.blocks.findLastIndex((b) => isPlanBlock(b) && (TASK_TOOLS.has(b.name) || planItems(b).length > 0))
  const planBlock = planIndex >= 0 ? (message.blocks[planIndex] as ToolBlock) : undefined
  let items = planBlock && !TASK_TOOLS.has(planBlock.name) ? planItems(planBlock) : []
  message.blocks.forEach((block, i) => {
    if (block.kind !== 'tool' || !TASK_TOOLS.has(block.name)) return
    applyTask(board, block)
    if (i === planIndex) items = [...board.values()]
  })
  const plan = planBlock && items.length ? planBlock : undefined
  const planSegment = plan ? kept.findIndex(({ blocks }) => blocks.includes(plan)) : -1

  return kept.map(({ blocks, segment }, i) => {
    const isLast = i === kept.length - 1
    const item: AgentItem = {
      kind: 'agent',
      key: `${message.id}:${segment}`,
      message,
      segment,
      isFirst: i === 0,
      isLast,
      blocks,
      plan: isLast && plan ? { block: plan, items, carried: planSegment !== i } : undefined
    }
    return { item, time: segment === 0 ? message.createdAt : splits[segment - 1], rank: segment === 0 ? 1 : 2, order, segment }
  })
}

/** `paneMemberId` builds an agent panel's view: only that agent's own turns split around
 *  your messages. Another agent's hand-off never saw them, so it stays one piece. */
export function buildTimeline(messages: Message[], paneMemberId?: string): TimelineItem[] {
  const visible = messages.filter((m) => !m.queued)
  const anchors = visible.filter((m) => m.author === 'user').map(anchorOf).sort((a, b) => a - b)
  const placed: Placed[] = []
  const boards = new TaskBoards()
  visible.forEach((message, order) => {
    if (message.author === 'user') placed.push({ item: { kind: 'user', key: message.id, message }, time: anchorOf(message), rank: 0, order, segment: 0 })
    else placed.push(...splitAgent(message, paneMemberId && message.author !== paneMemberId ? [] : anchors, order, boards.for(message)))
  })
  placed.sort((a, b) => a.time - b.time || a.rank - b.rank || a.order - b.order || a.segment - b.segment)
  return placed.map((p) => p.item)
}

function samePlan(a?: PlanView, b?: PlanView): boolean {
  if (!a || !b) return a === b
  return a.block === b.block && a.carried === b.carried && a.items.length === b.items.length &&
    a.items.every((item, i) => item.text === b.items[i].text && item.status === b.items[i].status && item.activeForm === b.items[i].activeForm)
}

function sameAgentItem(a: AgentItem, b: AgentItem): boolean {
  return a.message === b.message && a.segment === b.segment && a.isFirst === b.isFirst && a.isLast === b.isLast &&
    a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block === b.blocks[i]) && samePlan(a.plan, b.plan)
}

/** Returns `next` with every item that did not change replaced by its previous object,
 *  so memoized rows only re-render when their own part of the conversation changes. */
export function reuseItems(previous: TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  const byKey = new Map(previous.map((item) => [item.key, item]))
  return next.map((item) => {
    const old = byKey.get(item.key)
    if (!old || old.kind !== item.kind) return item
    if (old.kind === 'user') return old.message === item.message ? old : item
    return sameAgentItem(old, item as AgentItem) ? old : item
  })
}

export type LiveStep =
  | { kind: 'tool'; block: ToolBlock }
  | { kind: 'thinking'; block: Extract<Block, { kind: 'thinking' }> }

/** What an activity row of a running turn is doing now. A tool counts while it runs, even
 *  when an approval for it came in after it (it waits for you, then runs); thinking counts
 *  only while it is the newest thing the turn produced. */
export function liveStep(blocks: Block[], streaming: boolean, newest: Block | undefined): LiveStep | undefined {
  if (!streaming) return undefined
  const running = blocks.findLast((b): b is ToolBlock => b.kind === 'tool' && b.status === 'running' && !isPlanBlock(b))
  if (running) return { kind: 'tool', block: running }
  const last = blocks[blocks.length - 1]
  return last?.kind === 'thinking' && last === newest ? { kind: 'thinking', block: last } : undefined
}

export type SegmentPart =
  | { kind: 'text'; key: string; block: Extract<Block, { kind: 'text' }> }
  | { kind: 'activity'; key: string; blocks: Block[] }
  | { kind: 'approval'; key: string; block: Extract<Block, { kind: 'approval' }> }
  | { kind: 'error'; key: string; block: Extract<Block, { kind: 'error' }> }

/** Consecutive thinking and tool steps collapse into one activity row; text, approvals and
 *  errors stand on their own between them. Plan updates count in the row they sit in, but
 *  never make a row of their own: the task-list card already shows the plan. */
export function segmentParts(blocks: Block[]): SegmentPart[] {
  const parts: SegmentPart[] = []
  for (const block of blocks) {
    if (block.kind === 'thinking' || block.kind === 'tool') {
      const prev = parts[parts.length - 1]
      if (prev?.kind === 'activity') prev.blocks.push(block)
      else parts.push({ kind: 'activity', key: block.id, blocks: [block] })
    } else if (block.kind === 'text') {
      if (block.text.trim()) parts.push({ kind: 'text', key: block.id, block })
    } else if (block.kind === 'approval') parts.push({ kind: 'approval', key: block.id, block })
    else parts.push({ kind: 'error', key: block.id, block })
  }
  return parts.filter((part) => part.kind !== 'activity' || !part.blocks.every(isPlanBlock))
}
