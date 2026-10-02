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
  AskUserQuestion: 'Asked'
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

/** Why an account can't work right now, if it can't: not signed in, or a limit used up. */
export function accountProblem(info: AccountInfo | undefined): string | undefined {
  if (info?.loggedIn === false) return 'Not signed in. Sign in from Settings → Accounts first'
  const full = info?.limits.find((l) => l.percent >= 100)
  if (full) return `${full.label} limit reached${full.resetsAt ? `, resets in ${untilText(full.resetsAt)}` : ''}`
  return undefined
}
