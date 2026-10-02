import { PROVIDER_LABEL, activeMemberIds, type Attachment, type Block, type Message, type Room } from '@shared/types'

export interface ChatMarkdownOptions {
  exportedAt?: number
  /** A portable URL or relative path supplied by the export packager. */
  attachmentLink?: (attachment: Attachment) => string | undefined
  /** For example, why a missing attachment could not be packaged. */
  attachmentNote?: (attachment: Attachment) => string | undefined
  taskBoard?: string
}

/** Escape labels supplied by users without changing the actual conversation content. */
function inline(value: string): string {
  return value
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#|!~])/g, '\\$1')
}

function timestamp(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'Unknown'
}

/** Tool output and thinking can themselves contain Markdown fences of any length. */
function fenced(content: string, language = 'text'): string {
  let longest = 0
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`
}

function inputMarkdown(value: unknown): string {
  if (value === undefined) return '_No input recorded._'
  if (typeof value === 'string') return fenced(value)
  return fenced(JSON.stringify(value, null, 2), 'json')
}

function who(room: Room, id: string): string {
  if (id === 'user') return 'User'
  if (id === 'done') return 'DONE'
  const member = room.members.find((candidate) => candidate.id === id)
  if (member) return `${member.name} (@${member.handle})`
  const previous = room.messages.find((message) => message.author === id && message.authorName)
  return previous?.authorName ?? `Removed agent (${id})`
}

function duration(ms: number): string {
  const wholeSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  const parts = [hours ? `${hours} hr` : '', minutes ? `${minutes} min` : '', seconds || !hours && !minutes ? `${seconds} sec` : ''].filter(Boolean)
  return `${parts.join(' ')} (${ms} ms)`
}

function usageMarkdown(message: Message): string[] {
  const usage = message.usage
  if (!usage) return []
  const lines: string[] = []
  if (usage.steps !== undefined) lines.push(`- Model calls: ${usage.steps}`)
  if (usage.inputTokens !== undefined) lines.push(`- Input tokens, total (including cache reads): ${usage.inputTokens}`)
  if (usage.cachedTokens !== undefined) {
    lines.push(`- Input tokens read from cache: ${usage.cachedTokens}`)
    if (usage.inputTokens !== undefined) lines.push(`- New input tokens: ${Math.max(0, usage.inputTokens - usage.cachedTokens)}`)
  }
  if (usage.outputTokens !== undefined) lines.push(`- Output tokens (including reasoning): ${usage.outputTokens}`)
  if (usage.durationMs !== undefined) lines.push(`- Elapsed: ${duration(usage.durationMs)}`)
  return lines.length ? ['### Token usage and duration', '', ...lines] : []
}

function blockMarkdown(block: Block, index: number): string {
  const number = index + 1
  switch (block.kind) {
    case 'text':
      return `### ${number}. Response text\n\n${block.text || '_Empty text block._'}`
    case 'thinking':
      return `### ${number}. Recorded thinking\n\n${fenced(block.text)}`
    case 'error':
      return `### ${number}. Error\n\n${fenced(block.text)}`
    case 'tool': {
      const lines = [
        `### ${number}. Tool: ${inline(block.name)}`,
        '',
        `- Status: ${block.status}`,
        `- Reported an error: ${block.isError ? 'yes' : 'no'}`,
        '',
        '#### Input',
        '',
        inputMarkdown(block.input),
        '',
        '#### Output',
        '',
        block.output !== undefined ? fenced(block.output) : '_No output recorded._'
      ]
      return lines.join('\n')
    }
    case 'approval': {
      const lines = [
        `### ${number}. Approval: ${inline(block.toolName)}`,
        '',
        `- Status: ${block.status}`,
        `- Can always allow: ${block.canAlways ? 'yes' : 'no'}`
      ]
      if (block.description !== undefined) lines.push('', '#### Description', '', block.description)
      lines.push('', '#### Requested input', '', inputMarkdown(block.input))
      for (const [questionIndex, question] of (block.questions ?? []).entries()) {
        lines.push(
          '',
          `#### Question ${questionIndex + 1}${question.header ? `: ${inline(question.header)}` : ''}`,
          '',
          `- Question ID: ${inline(question.id)}`,
          `- Selection: ${question.multiSelect ? 'multiple choices' : 'single choice'}`,
          '',
          fenced(question.question),
          '',
          'Options:',
          '',
          fenced(JSON.stringify(question.options, null, 2), 'json')
        )
      }
      if (block.answers !== undefined) lines.push('', '#### Recorded answers', '', fenced(JSON.stringify(block.answers, null, 2), 'json'))
      return lines.join('\n')
    }
  }
}

function linkDestination(value: string): string {
  // Angle-delimited destinations allow parentheses. Encode whitespace, angle
  // brackets and backslashes so filenames cannot end the Markdown link.
  return value.replace(/[\s<>\\]/g, (character) => encodeURIComponent(character))
}

function attachmentsMarkdown(message: Message, options: ChatMarkdownOptions): string[] {
  if (!message.attachments?.length) return []
  const parts = ['### Attachments']
  for (const attachment of message.attachments) {
    const destination = options.attachmentLink?.(attachment)
    const name = inline(attachment.name)
    parts.push('', destination ? `[${name}](<${linkDestination(destination)}>)` : name)
    parts.push('', `- Type: ${inline(attachment.mime)}`, `- Size: ${attachment.size} bytes`)
    if (destination && attachment.mime.startsWith('image/')) parts.push('', `![${name}](<${linkDestination(destination)}>)`)
    const note = options.attachmentNote?.(attachment)
    if (note) parts.push('', inline(note))
    else if (!destination) parts.push('', '_Attachment file is not included in this Markdown text._')
  }
  return parts
}

function normalizedText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function messageMarkdown(message: Message, index: number, room: Room, options: ChatMarkdownOptions): string {
  const member = room.members.find((candidate) => candidate.id === message.author)
  const author = message.author === 'user' ? 'User' : member ? who(room, member.id) : message.authorName ?? who(room, message.author)
  const provider = message.provider ?? member?.provider
  const parts = [
    `## ${index + 1}. ${inline(author)}`,
    '',
    `- Sent: ${timestamp(message.createdAt)}`,
    `- Status: ${message.status}`
  ]
  if (message.author !== 'user' && provider) parts.push(`- Provider: ${PROVIDER_LABEL[provider]}`)
  if (message.to !== undefined) parts.push(`- Recipients: ${message.to.length ? message.to.map((id) => inline(who(room, id))).join(', ') : 'none recorded'}`)
  if (message.hop !== undefined) parts.push(`- Relay hop: ${message.hop}`)
  if (message.undone) parts.push('- File changes: undone')
  if (message.execution) parts.push(`- Starting model: ${inline(message.execution.model || 'default')}`, `- Starting effort: ${inline(message.execution.effort || 'default')}`, `- Delegated settings: ${message.execution.delegated ? 'yes' : 'no'}`)
  if (message.sharedChanges) parts.push('- File snapshot overlaps other agents working in the same folder.')

  const textBlocks = message.blocks.filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
  const reply = normalizedText(message.text)
  const recordedText = textBlocks.map((block) => normalizedText(block.text)).filter(Boolean).join('\n\n')
  const textAlreadyRecorded = reply === recordedText || textBlocks.some((block) => normalizedText(block.text) === reply)
  if (message.author === 'user' && message.text && !textAlreadyRecorded) parts.push('', message.text)
  for (const [blockIndex, block] of message.blocks.entries()) parts.push('', blockMarkdown(block, blockIndex))
  if (message.author !== 'user' && message.text && !textAlreadyRecorded) parts.push('', '### Final reply', '', message.text)
  if (!message.text && !message.blocks.length) parts.push('', message.status === 'streaming' ? '_Reply is still in progress; no output has been recorded yet._' : '_No reply content recorded._')

  parts.push(...(message.attachments?.length ? ['', ...attachmentsMarkdown(message, options)] : []))
  if (message.handoff) {
    const target = message.handoff.to
    const route = target === 'done' ? '→ DONE' : `→ ${target === 'user' ? '@user' : who(room, target)}: ${message.handoff.text}`
    parts.push('', '### Routing', '', route)
    if (message.handoff.overrides) parts.push('', `- One-turn settings: ${Object.entries(message.handoff.overrides).map(([key, value]) => `${key}=${inline(value || 'default')}`).join(', ')}`)
    if (message.handoff.error) parts.push(`- Routing issue: ${inline(message.handoff.error)}`)
    if (target !== 'done' && target !== 'user') parts.push('', `- Forwarded: ${message.handoffDone ? 'yes' : 'no'}`)
  }
  const usage = usageMarkdown(message)
  if (usage.length) parts.push('', ...usage)
  if (message.diff !== undefined) {
    parts.push('', '### Recorded file changes', '', `- Undone: ${message.undone ? 'yes' : 'no'}`, '', fenced(message.diff, 'diff'))
  }
  return parts.join('\n')
}

/** A complete snapshot of data already recorded by Interface. Internal prompts,
 * provider session identifiers and git snapshot hashes are deliberately omitted. */
export function formatChatMarkdown(room: Room, options: ChatMarkdownOptions = {}): string {
  const parts = [
    `# ${inline(room.title || 'Untitled chat')}`,
    '',
    '- Exported from: Interface',
    `- Exported at: ${timestamp(options.exportedAt ?? Date.now())}`,
    `- Chat created: ${timestamp(room.createdAt)}`,
    `- Last updated: ${timestamp(room.updatedAt)}`,
    `- Room type: ${room.kind}`,
    `- Project folder: ${inline(room.folder)}`,
    `- Messages: ${room.messages.length}`,
    '',
    'This export contains the conversation, thinking text made available to Interface, tool inputs and outputs, approvals, and saved file changes already retained by the app. Provider-private traces are not retrieved. Previously clipped tool output cannot be recovered by exporting. It is a snapshot; replies still in progress may be incomplete.',
    '',
    '## Participants and current settings',
    '',
    'These are the current settings. Historical model and effort choices are not recorded separately for each reply.'
  ]
  const active = activeMemberIds(room)
  if (!room.members.length) parts.push('', '_No current participants._')
  for (const member of room.members) {
    parts.push(
      '',
      `### ${inline(who(room, member.id))}`,
      '',
      `- Provider: ${PROVIDER_LABEL[member.provider]}`,
      `- Model: ${inline(member.settings.model || 'Provider default')}`,
      `- Effort: ${inline(member.settings.effort || 'Provider default')}`,
      `- ${member.provider === 'claude' ? 'Permission mode' : 'Codex mode'}: ${inline(member.provider === 'claude' ? member.settings.permissionMode : member.settings.codexMode)}`,
      `- Selected for this chat: ${active.includes(member.id) ? 'yes' : 'no'}`
    )
  }
  parts.push('', '---', '', '## Conversation')
  if (!room.messages.length) parts.push('', '_No messages yet._')
  for (const [messageIndex, message] of room.messages.entries()) parts.push('', messageMarkdown(message, messageIndex, room, options), '', '---')
  if (options.taskBoard !== undefined) parts.push('', '## Task board', '', options.taskBoard || '_The task board is empty._')
  return `${parts.join('\n')}\n`
}

function safeBasename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s-]+$/g, '')
  let limited = ''
  for (const character of cleaned) {
    if (Buffer.byteLength(limited + character, 'utf8') > 180) break
    limited += character
  }
  limited = limited.replace(/[.\s-]+$/g, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(limited) ? `Chat-${limited}` : limited
}

/** A basename usable on macOS, Windows or Linux, never a filesystem path. */
export function chatExportFilename(room: Pick<Room, 'title' | 'id'>): string {
  const title = safeBasename(room.title.replace(/\.md$/i, ''))
  return `${title || safeBasename(`Chat-${room.id}`) || 'Chat'}.md`
}
