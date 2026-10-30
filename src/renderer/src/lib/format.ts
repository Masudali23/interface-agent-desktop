import type { AccountInfo, AgentStatus, Block, Message, MessageUsage } from '@shared/types'

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function relative(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '')
  if (path === base) return basename(path)
  if (path.startsWith(base + '/') || path.startsWith(base + '\\')) return path.slice(base.length + 1)
  return path
}

export function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString()
}

export function tokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

/** The footer under a reply and its tooltip: new input, output and steps, with cached
 *  re-reads (the conversation sent again on every tool step) only in the tooltip. */
export function usageText(u: MessageUsage): { text: string; title: string } {
  const time = u.durationMs ? seconds(u.durationMs) : ''
  if (u.cachedTokens === undefined) {
    // Saved before the split existed.
    return { text: [`${tokens(u.inputTokens)} in`, `${tokens(u.outputTokens)} out`, time].filter(Boolean).join(' · '), title: 'Tokens read and written in this turn' }
  }
  const fresh = Math.max(0, (u.inputTokens ?? 0) - u.cachedTokens)
  const steps = u.steps ? `${u.steps} ${u.steps === 1 ? 'step' : 'steps'}` : ''
  const text = [steps, `${tokens(fresh)} in`, `${tokens(u.outputTokens)} out`, time].filter(Boolean).join(' · ')
  const title = [
    `${tokens(fresh)} new input tokens`,
    `${tokens(u.cachedTokens)} re-read from cache${u.steps && u.steps > 1 ? ` (the conversation is sent again on each of the ${u.steps} steps)` : ''}`,
    `${tokens(u.inputTokens)} input in total`,
    `${tokens(u.outputTokens)} output tokens, reasoning included`,
    time ? `took ${time}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return { text, title }
}

export function seconds(ms?: number): string {
  if (!ms) return ''
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
}

export const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: 'Ready',
  starting: 'Starting',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Needs you',
  error: 'Error'
}

export function isBusy(status?: AgentStatus): boolean {
  return status === 'starting' || status === 'thinking' || status === 'working' || status === 'waiting'
}

type Input = Record<string, unknown>

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
}

/** One-line description of a tool call, like Claude desktop shows. */
export function toolSummary(name: string, input: unknown, root: string): string {
  const i = (input ?? {}) as Input
  const path = (p: unknown): string => relative(str(p), root)
  switch (name) {
    case 'Bash':
    case 'Shell':
      return str(i.command).split('\n')[0]
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return path(i.file_path ?? i.notebook_path)
    case 'Glob':
      return str(i.pattern)
    case 'Grep':
      return `${str(i.pattern)}${i.path ? ` in ${path(i.path)}` : ''}`
    case 'WebFetch':
      return str(i.url)
    case 'WebSearch':
    case 'Web search':
      return str(i.query)
    case 'Task':
    case 'Agent':
      return str(i.description)
    case 'TodoWrite':
      return `${Array.isArray(i.todos) ? i.todos.length : 0} items`
    case 'Edit files':
      return (Array.isArray(i.changes) ? i.changes : []).map((c: Input) => path(c.path)).join(', ')
    case 'Plan':
      return `${Array.isArray(i.items) ? i.items.length : 0} steps`
    case 'TaskCreate':
      return str(i.subject ?? i.description)
    case 'TaskUpdate':
      return [i.taskId != null ? `#${str(i.taskId)}` : '', typeof i.status === 'string' ? i.status.replace(/_/g, ' ') : '', str(i.subject)].filter(Boolean).join(' · ')
    case 'ToolSearch':
      return str(i.query).replace(/^select:/, '').split(',').join(', ')
    case 'Skill':
      return str(i.skill ?? i.command)
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string')
      return str(first).split('\n')[0]
    }
  }
}

export const TOOL_VERB: Record<string, string> = {
  Bash: 'Ran',
  Shell: 'Ran',
  Read: 'Read',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  Write: 'Wrote',
  NotebookEdit: 'Edited',
  Glob: 'Found files',
  Grep: 'Searched',
  WebFetch: 'Fetched',
  WebSearch: 'Searched the web',
  'Web search': 'Searched the web',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'Updated todos',
  'Edit files': 'Changed files',
  Plan: 'Plan',
  Compact: 'Compacted',
  'View image': 'Viewed image',
  'Generate image': 'Generated image',
  Review: 'Review',
  ExitPlanMode: 'Plan ready',
  AskUserQuestion: 'Asked',
  TaskCreate: 'Added a task',
  TaskUpdate: 'Updated a task',
  TaskList: 'Listed tasks',
  TaskGet: 'Read a task',
  TaskStop: 'Stopped a task',
  ToolSearch: 'Loaded tools'
}

/** Time left until a limit resets, like "3 hr 5 min" or "2 days 4 hr". */
export function untilText(ts: number): string {
  const mins = Math.ceil((ts - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}${h ? ` ${h} hr` : ''}`
  if (h > 0) return `${h} hr${m ? ` ${m} min` : ''}`
  return `${m} min`
}

export function resetText(ts?: number): string {
  if (!ts) return ''
  return ts <= Date.now() ? 'resets soon' : `resets in ${untilText(ts)}`
}

/** The exact reset moment, for tooltips: "Thu 8 Oct, 14:30". */
export function resetAt(ts: number): string {
  return new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function changedFiles(messages: Message[]): Array<{ path: string; author: string; color?: string; at: number }> {
  const seen = new Map<string, { path: string; author: string; color?: string; at: number }>()
  for (const m of messages) {
    if (m.author === 'user') continue
    for (const b of m.blocks as Block[]) {
      if (b.kind !== 'tool' || b.status === 'error') continue
      const i = (b.input ?? {}) as Input
      const paths: string[] = []
      if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(b.name)) paths.push(str(i.file_path ?? i.notebook_path))
      if (b.name === 'Edit files' && Array.isArray(i.changes)) for (const c of i.changes as Input[]) paths.push(str(c.path))
      for (const p of paths) if (p) seen.set(p, { path: p, author: m.authorName ?? m.author, color: m.color, at: m.createdAt })
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at)
}

export function joinPath(root: string, rel: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) return rel
  return `${root.replace(/[\\/]$/, '')}/${rel}`
}

export function languageOf(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp',
    hpp: 'cpp', cc: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml',
    css: 'css', scss: 'scss', sql: 'sql', m: 'matlab', r: 'r', lua: 'lua', dart: 'dart', vue: 'xml', svelte: 'xml',
    dockerfile: 'dockerfile', makefile: 'makefile', tex: 'latex'
  }
  return map[ext]
}

/** Limits that stop the whole account: Claude's 5-hour and all-models weekly windows and
 *  Codex's own windows. A per-model, per-app or extra-usage limit leaves other work possible. */
const ACCOUNT_LIMITS = new Set(['session', 'weekly_all', 'five_hour', 'seven_day', 'codex:primary', 'codex:secondary'])

/** Why an account can't work right now, if it can't: not signed in, or a limit used up
 *  that has not reset yet (usage refreshes only every few minutes). */
export function accountProblem(info: AccountInfo | undefined, now = Date.now()): string | undefined {
  if (info?.loggedIn === false) return 'Not signed in. Sign in from Settings → Accounts first'
  const full = info?.limits.find((l) => ACCOUNT_LIMITS.has(l.id) && l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now))
  if (full) return `${full.label} limit reached${full.resetsAt ? `, resets in ${untilText(full.resetsAt)}` : ''}`
  return undefined
}

const COMMAND_TOOLS = ['Bash', 'Shell']
const READ_TOOLS = ['Read', 'View image']
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Edit files']
const SEARCH_TOOLS = ['Glob', 'Grep']
const WEB_SEARCH_TOOLS = ['WebSearch', 'Web search']
const AGENT_TOOLS = ['Task', 'Agent']
const PLAN_TOOLS = ['TodoWrite', 'Plan', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']

/** A readable name for a tool, without the MCP server prefix. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__.+?__(.+)$/.exec(name)
  if (mcp) return mcp[1].replace(/_/g, ' ')
  const codexMcp = /^[^:]+:\s*(.+)$/.exec(name)
  return codexMcp ? codexMcp[1] : name
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace('#', String(n))
}

function editedFileKeys(name: string, input: unknown, fallback: string): string[] {
  const i = (input ?? {}) as Input
  if (name === 'Edit files') {
    const paths = (Array.isArray(i.changes) ? (i.changes as Input[]) : []).map((c) => str(c?.path)).filter(Boolean)
    return paths.length ? paths : [fallback]
  }
  return [str(i.file_path ?? i.notebook_path) || fallback]
}

/** Past-tense summary of a run of steps, like Claude desktop: "Ran 2 commands, read a file". */
export function activitySummary(blocks: Block[]): { text: string; failed: number } {
  const order: string[] = []
  const tally = new Map<string, { n: number; keys: Set<string>; name?: string }>()
  const add = (group: string, key: string, name?: string): void => {
    let entry = tally.get(group)
    if (!entry) {
      entry = { n: 0, keys: new Set(), name }
      tally.set(group, entry)
      order.push(group)
    }
    entry.n++
    entry.keys.add(key)
  }
  let failed = 0
  let thought = false
  for (const b of blocks) {
    if (b.kind === 'thinking') thought = true
    if (b.kind !== 'tool') continue
    if (b.status === 'error' || b.isError) failed++
    const i = (b.input ?? {}) as Input
    if (COMMAND_TOOLS.includes(b.name)) add('command', b.id)
    else if (READ_TOOLS.includes(b.name)) add('read', str(i.file_path ?? i.path) || b.id)
    else if (EDIT_TOOLS.includes(b.name)) for (const key of editedFileKeys(b.name, b.input, b.id)) add('edit', key)
    else if (SEARCH_TOOLS.includes(b.name)) add('search', b.id)
    else if (b.name === 'WebFetch') add('fetch', str(i.url) || b.id)
    else if (WEB_SEARCH_TOOLS.includes(b.name)) add('web', b.id)
    else if (AGENT_TOOLS.includes(b.name)) add('agent', b.id)
    else if (PLAN_TOOLS.includes(b.name)) add('plan', b.id)
    else if (b.name === 'ToolSearch') add('tools', b.id)
    else if (b.name === 'TaskStop') add('stop', b.id)
    else if (b.name === 'Compact') add('compact', b.id)
    else if (b.name === 'Skill') add('skill', b.id)
    else if (b.name === 'AskUserQuestion') add('ask', b.id)
    else if (b.name === 'ExitPlanMode') add('present', b.id)
    else if (b.name === 'Generate image') add('image', b.id)
    else if (b.name === 'Review') add('review', b.id)
    else add('other', b.id, toolLabel(b.name))
  }
  const phrase = (group: string): string => {
    const { n, keys, name } = tally.get(group)!
    const files = keys.size
    switch (group) {
      case 'command': return count(n, 'ran a command', 'ran # commands')
      case 'read': return count(files, 'read a file', 'read # files')
      case 'edit': return count(files, 'edited a file', 'edited # files')
      case 'search': return count(n, 'searched files', 'ran # searches')
      case 'fetch': return count(files, 'fetched a page', 'fetched # pages')
      case 'web': return count(n, 'searched the web', 'searched the web # times')
      case 'agent': return count(n, 'ran an agent', 'ran # agents')
      case 'plan': return 'updated the plan'
      case 'tools': return 'loaded tools'
      case 'stop': return count(n, 'stopped a background task', 'stopped # background tasks')
      case 'compact': return 'compacted the conversation'
      case 'skill': return count(n, 'used a skill', 'used # skills')
      case 'ask': return count(n, 'asked a question', 'asked # questions')
      case 'present': return 'presented a plan'
      case 'image': return count(n, 'generated an image', 'generated # images')
      case 'review': return 'reviewed changes'
      default: return count(n, `used ${name}`, 'used # tools')
    }
  }
  const text = order.length ? order.map(phrase).join(', ') : thought ? 'thought' : ''
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed }
}

/** What a running tool is doing right now: "Running a command". */
export function toolProgress(name: string): string {
  if (COMMAND_TOOLS.includes(name)) return 'Running a command'
  if (READ_TOOLS.includes(name)) return 'Reading a file'
  if (EDIT_TOOLS.includes(name)) return 'Editing a file'
  if (SEARCH_TOOLS.includes(name)) return 'Searching'
  if (name === 'WebFetch') return 'Fetching a page'
  if (WEB_SEARCH_TOOLS.includes(name)) return 'Searching the web'
  if (AGENT_TOOLS.includes(name)) return 'Running an agent'
  if (PLAN_TOOLS.includes(name)) return 'Updating the plan'
  if (name === 'ToolSearch') return 'Loading tools'
  if (name === 'Compact' || name === 'compact' || name === 'compacting') return 'Compacting the conversation'
  if (name === 'review' || name === 'Review') return 'Reviewing changes'
  return `Using ${toolLabel(name)}`
}

/** The live activity of an agent, from its runtime status. */
export function runtimeActivity(runtime?: { status: AgentStatus; detail?: string }): string {
  switch (runtime?.status) {
    case 'starting':
      return 'Starting'
    case 'thinking':
      return runtime.detail === 'retrying' ? 'Retrying' : 'Thinking'
    case 'working':
      return runtime.detail ? toolProgress(runtime.detail) : 'Working'
    case 'waiting':
      return 'Waiting for you'
    default:
      return ''
  }
}

/** A running duration: "38s", "1m 4s", "1h 2m". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Rough output size of a turn so far (about four characters per token). */
export function estimateTokens(message: Message): number {
  let chars = 0
  for (const b of message.blocks) {
    if (b.kind === 'text' || b.kind === 'thinking') chars += b.text.length
    else if (b.kind === 'tool') chars += b.input == null ? 0 : JSON.stringify(b.input).length
  }
  return Math.round(chars / 4)
}
