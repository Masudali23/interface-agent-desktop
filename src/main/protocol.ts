// The room protocol for team rooms: what each agent is told about the other
// participants, how new messages are forwarded, and how routing lines are read back.
// Solo rooms skip all of this, so Claude Code or Codex behave exactly as they do on
// their own.

import { PROVIDER_LABEL, activeMemberIds, defaultRecipients, type Block, type Handoff, type Member, type Message, type Room } from '@shared/types'

export function collabDir(roomId: string): string {
  return `.collab/${roomId}`
}

export function isTeam(room: Room): boolean {
  return room.members.length > 1
}

function who(m: Member): string {
  return `@${m.handle} (${m.name}, ${PROVIDER_LABEL[m.provider]})`
}

export function systemPrompt(member: Member, room: Room): string | undefined {
  if (!isTeam(room)) return undefined
  const others = room.members.filter((m) => m.id !== member.id)
  const dir = collabDir(room.id)
  const lead = room.dispatch === 'lead' ? room.members.find((candidate) => candidate.id === defaultRecipients(room)[0]) : undefined
  const lines = [
    '# Shared room',
    `You are ${who(member)}, one of ${room.members.length} AI agents working with the user in a shared room. The user sees everything everyone writes.`,
    `The other agents: ${others.map(who).join(', ')}.`,
    '',
    '- New messages from the user and the other agents are forwarded to you inside <room-update> blocks.',
    '- The others cannot see your tool calls, only your final reply text, so put everything they need into your reply.',
    `- Project folder: ${room.folder}`,
    `- Full room transcript: ${room.folder}/${dir}/chat.md`,
    `- Shared task board: ${room.folder}/${dir}/tasks.md. Keep it current when you plan or split work. One task per line: "- [ ] description — owner: @handle — files: …". Tick it "- [x]" when done.`,
    '- Split work by file ownership. Do not edit files that a task assigns to someone else unless asked. When the user says who does which part, do only your part.',
    '- When you ask another agent for something, be specific: what to do, which files, and how to report back.',
    '- Messages arriving while you work are feedback or a continuation of your current task. Incorporate them promptly, preserve the original objective unless the user changes it, and complete the combined work before handing off. Do not repeat work already reported complete.',
    `- Available participants: ${room.members.filter((candidate) => activeMemberIds(room).includes(candidate.id)).map((candidate) => `@${candidate.handle} (model=${candidate.settings.model || 'default'}, effort=${candidate.settings.effort || 'default'})`).join(', ')}. Unticked agents require an explicit user action to run.`,
    '- Avoid duplicate investigation and repeated full transcripts. Delegate bounded tasks, share concise findings with file references, and run relevant checks before declaring completion.',
    `- Available model IDs and effort options are recorded in ${room.folder}/${dir}/models.json. Choose a suitable smaller model/lower effort for straightforward delegated work and a stronger model for difficult work or final review. Do not assume model prices from names.`,
    '- Optional one-turn delegation settings: → @handle [model=MODEL_ID effort=EFFORT]: task. Use only model IDs/efforts in models.json. Omit either setting to keep that agent’s choice. These overrides do not change saved user preferences.'
  ]
  if (lead) lines.push(member.id === lead.id
    ? `- You are the lead coordinator. Keep the user's whole objective, assign bounded work to the selected specialists when useful, integrate their results and verify the final implementation. Avoid starting every agent on the same task.`
    : `- @${lead.handle} is the lead coordinator. Complete only your assigned task, report changed files and validation, and hand results back to @${lead.handle} for integration and final verification.`)
  if (member.worktree) {
    lines.push(
      `- You work in your own git worktree at ${member.worktree.path} on branch ${member.worktree.branch}. The others do not see your file changes until the user merges them, so describe what you changed.`
    )
  }
  lines.push(
    '',
    'End your turn with exactly one routing line, as the very last line of your final message (not in progress updates):',
    ...others.map((o) => `→ @${o.handle}: <what you need ${o.name} to do next>`),
    '→ @user: <question or short summary for the user>',
    '→ DONE',
    'Hand off to another agent only when they actually have to act next. Otherwise use → @user or → DONE.'
  )
  return lines.join('\n')
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function nameOf(room: Room, id: string): string {
  const m = room.members.find((x) => x.id === id)
  return m ? `@${m.handle}` : id
}

function header(m: Message, room: Room): string {
  if (m.author === 'user') {
    const to = (m.to ?? []).map((id) => nameOf(room, id)).join(', ')
    return to ? `USER → ${to}` : 'USER'
  }
  const member = room.members.find((x) => x.id === m.author)
  return member ? `@${member.handle} (${member.name})` : (m.authorName ?? m.author)
}

function handoffLine(h: Handoff, room: Room): string {
  if (h.to === 'done') return '→ DONE'
  if (h.to === 'user') return `→ @user: ${h.text}`
  const overrides = h.overrides ? Object.entries(h.overrides).map(([key, value]) => `${key}=${value || 'default'}`).join(' ') : ''
  return `→ ${nameOf(room, h.to)}${overrides ? ` [${overrides}]` : ''}: ${h.text}`
}

/** One message as Markdown, used for the forwarded update and chat.md. */
export function renderMessage(m: Message, room: Room, withTime = false): string {
  const lines = [`### ${header(m, room)}${withTime ? ` · ${stamp(m.createdAt)}` : ''}`]
  lines.push((m.author === 'user' ? m.text : m.text || '(no text reply)').trim())
  if (m.attachments?.length) lines.push(`Attachments: ${m.attachments.map((a) => a.path).join(', ')}`)
  if (m.status === 'stopped') lines.push('(stopped by the user)')
  if (m.status === 'error') lines.push('(this turn ended with an error)')
  if (m.handoff) lines.push(handoffLine(m.handoff, room))
  return lines.join('\n')
}

/** Messages this member has not been shown yet: everything finished and not its own. */
export function pendingFor(memberId: string, messages: Message[]): Message[] {
  return messages.filter((m) => m.author !== memberId && m.status !== 'streaming' && !(m.deliveredTo ?? []).includes(memberId))
}

/**
 * What the agent is sent for its turn. In a solo room this is just what you typed,
 * exactly as if you typed it into Claude Code or Codex.
 */
export function formatUpdate(member: Member, pending: Message[], room: Room, includeRules = false, mode: 'turn' | 'feedback' = 'turn'): string {
  if (!isTeam(room)) {
    return pending
      .filter((m) => m.author === 'user')
      .map((m) => (m.attachments?.length ? `${m.text}\n\nAttached files: ${m.attachments.map((a) => a.path).join(', ')}` : m.text))
      .join('\n\n')
  }
  const parts: string[] = []
  const rules = includeRules ? systemPrompt(member, room) : undefined
  if (rules) parts.push(rules, '')
  parts.push('<room-update>')
  for (const m of pending) {
    const addressed = m.author === 'user' || m.handoff?.to === member.id || m === pending.at(-1)
    if (!addressed && m.text.length > 1200) {
      parts.push(renderMessage({ ...m, text: `${m.text.slice(0, 1200)}\n[Background reply shortened. Full text: ${room.folder}/${collabDir(room.id)}/chat.md]` }, room), '')
    } else parts.push(renderMessage(m, room), '')
  }
  parts.push('</room-update>', '')
  parts.push(mode === 'feedback'
    ? `@${member.handle}, these messages arrived while you were working. Treat them as feedback or a continuation of your current task. Incorporate them now, preserve the original objective unless the user changes it, and finish the combined work before your final reply. Do not repeat work already reported complete. End only your final reply with your routing line.`
    : `It's your turn, @${member.handle}. Respond to the latest message addressed to you while preserving any unfinished objective, then end with your routing line.`)
  return parts.join('\n')
}

const ROUTE_RE = /^[\s>*_`]*(?:→|->|=>|➡️?)[\s*_`]*(?:@([\w.-]+)[*_]*(.*)|(DONE)\b.*)$/i

const GENERIC: Record<string, 'claude' | 'codex'> = { claude: 'claude', gpt: 'codex', codex: 'codex', chatgpt: 'codex', openai: 'codex' }

/** Resolves a handle written in a routing line to a member id, 'user', or undefined. */
export function resolveHandle(handle: string, room: Room, from?: string): string | undefined {
  const h = handle.toLowerCase().replace(/[.,;:!?-]+$/, '')
  if (h === 'user' || h === 'you') return 'user'
  const exact = room.members.find((m) => m.handle.toLowerCase() === h)
  if (exact) return exact.id
  const provider = GENERIC[h]
  if (provider) {
    const candidates = room.members.filter((m) => m.provider === provider && m.id !== from)
    if (candidates.length === 1) return candidates[0].id
  }
  return undefined
}

/**
 * Finds the routing line in the last few lines of a reply.
 * Returns the hand-off and the text with the routing line removed.
 */
export function parseHandoff(text: string, room: Room, from?: string): { handoff?: Handoff; body: string } {
  const lines = text.replace(/\s+$/, '').split('\n')
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const match = ROUTE_RE.exec(lines[i])
    if (!match) continue
    const to = match[3] ? 'done' : resolveHandle(match[1], room, from)
    if (!to) continue
    const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/\s+$/, '')
    let task = match[2] ?? ''
    const handoff: Handoff = { to, text: '' }
    // Brackets are also normal task text and Markdown links. Only a model/effort
    // assignment before the routing colon opts into delegation settings.
    const options = /^\s+\[([^\]\r\n]*)(\])?/.exec(task)
    if (options && /(?:^|\s)(?:model|effort)\s*=/i.test(options[1])) {
      handoff.overrides = {}
      if (!options[2]) handoff.error = 'Unclosed delegation settings. Use [model=ID effort=LEVEL].'
      else {
        task = task.slice(options[0].length)
        for (const option of options[1].trim().split(/\s+/)) {
          const setting = /^(model|effort)=([^\s=]+)$/.exec(option)
          if (!setting) { handoff.error = 'Unsupported delegation settings. Use model=ID and effort=LEVEL.'; continue }
          handoff.overrides[setting[1] as 'model' | 'effort'] = setting[2] === 'default' ? '' : setting[2]
        }
      }
    }
    handoff.text = to === 'done' ? '' : task.replace(/^\s*:?\s*(?:\*\*|__|\*|_)?\s*/, '').replace(/(\*\*|__)$/, '').trim()
    return { handoff, body }
  }
  return { body: text }
}

export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Default room title from the first user message. */
export function titleFrom(text: string): string {
  const clean = text.replace(/(^|\s)@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return 'New session'
  const words = clean.split(' ').slice(0, 7).join(' ')
  return words.length > 48 ? `${words.slice(0, 47)}…` : words
}
