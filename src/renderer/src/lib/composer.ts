import { parseMentions, type Mentionable } from '@shared/mentions'
import type { AgentStatus, Attachment, Message, QueuedDraft, Room } from '@shared/types'
import { composerDraftKey, composerRecipients, type RoomLayout } from './agentPanes'
import { composerDrafts } from './composerDrafts'
import { basename, isBusy } from './format'

/** The "@word" or "/word" being typed right before the cursor. Commands only count at the start. */
export function activeToken(text: string, caret: number): { start: number; token: string } | undefined {
  if (caret < 0) return undefined
  const before = text.slice(0, caret)
  const m = /(^|\s)([@/][^\s]*)$/.exec(before)
  if (!m) return undefined
  const start = before.length - m[2].length
  if (m[2][0] === '/' && start !== 0) return undefined
  return { start, token: m[2] }
}

/** Starts a mention at the cursor or a command at the start of the text, ready for the suggestion menu. */
export function insertTrigger(text: string, caret: number, trigger: '@' | '/'): { text: string; caret: number } {
  if (trigger === '/') {
    if (text.startsWith('/')) return { text, caret: 1 }
    return { text: `/${text.trimStart()}`, caret: 1 }
  }
  const at = Math.max(0, Math.min(caret, text.length))
  const gap = at > 0 && !/\s/.test(text[at - 1]) ? ' ' : ''
  const insert = `${gap}@`
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length }
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function isMac(platform: string): boolean {
  return platform === 'darwin'
}

export function composerPlaceholder(options: { platform: string; busy: boolean; team: boolean; names: string[]; memberName?: string }): string {
  const { platform, busy, team, names, memberName } = options
  if (busy) return isMac(platform) ? '↵ to send, ⌘↵ to queue for later' : 'Enter to send, Ctrl+Enter to queue for later'
  if (memberName) return `Message ${memberName}…`
  if (team) return `Message ${listNames(names)} · @ to mention, / for commands`
  return 'Type / for commands'
}

export type ComposerKeyAction = 'send' | 'queue' | 'stop'

interface KeyLike { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

/**
 * Enter sends (joining a running turn as feedback), ⌘↵ on macOS or Ctrl+Enter elsewhere
 * queues the message as its own turn while a recipient is busy, Esc stops a busy agent.
 * Anything else, Shift+Enter included, is left to the textarea.
 */
export function composerKeyAction(e: KeyLike, platform: string, busy: boolean): ComposerKeyAction | undefined {
  if (e.key === 'Escape') return busy && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? 'stop' : undefined
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return undefined
  const queueKey = isMac(platform) ? e.metaKey : e.ctrlKey
  const otherKey = isMac(platform) ? e.ctrlKey : e.metaKey
  if (otherKey) return undefined
  if (queueKey) return busy ? 'queue' : 'send'
  return 'send'
}

/** Queued messages waiting for the room composer, or for one agent's pane composer. */
export function queuedMessages(messages: Message[], memberId?: string): Message[] {
  return messages.filter((m) => m.author === 'user' && m.queued && (!memberId || !!m.to?.includes(memberId)))
}

/** Collapses a message to one line for compact previews. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function isImage(attachment: Attachment): boolean {
  return attachment.mime.startsWith('image/')
}

/** URL the iface:// protocol serves a saved attachment from. */
export function attachmentSrc(roomId: string, path: string): string {
  return `iface://attachment/${roomId}/${encodeURIComponent(basename(path))}`
}

/** Recipients of this composer that are mid-turn: what its stop button and Esc stop. */
export function busyRecipients(recipients: string[], statuses: Record<string, { status?: AgentStatus } | undefined> | undefined): string[] {
  return recipients.filter((id) => isBusy(statuses?.[id]?.status))
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x))

/** Text sent for a message that only carries attachments. */
export const ATTACHMENT_ONLY_TEXT = '(see attachment)'

/** What the user typed for a queued message: the attachment-only stand-in comes back as nothing. */
export function restoredText(draft: QueuedDraft): string {
  return draft.attachments.length && draft.text.trim() === ATTACHMENT_ONLY_TEXT ? '' : draft.text
}

/**
 * Text the room composer sends. The main process only runs a message as a slash command when
 * it starts with "/", so addressing mentions in front of one ("@claude /compact", which is also
 * how a taken-back command returns) come off: the mentions still choose the recipients.
 */
export function outgoingText(text: string, members: Mentionable[]): string {
  const m = /^\s*(@[\w.-]+(?:\s*(?:,|\band\b)?\s*@[\w.-]+)*)[\s,:]+(\/[\w:.-]+(?:\s[\s\S]*)?)$/i.exec(text)
  return m && parseMentions(m[1], members) ? m[2] : text
}

/**
 * The queued message runs as a command (Claude slash commands, Codex /review and /compact),
 * which the main process only starts after the current turn, so it cannot be sent now.
 */
export function queuedAsCommand(room: Room, message: Pick<Message, 'text' | 'to'>): boolean {
  const slash = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(message.text.trim())
  if (!slash) return false
  return room.members.some((m) => !!message.to?.includes(m.id) && (m.provider === 'claude' || (m.provider === 'codex' && (slash[1] === 'review' || slash[1] === 'compact'))))
}

/**
 * Where a taken-back queued message goes so that sending it again reaches the same agents.
 * A pane composer keeps messages addressed only to its agent. Anything else returns to the
 * room composer, with @mentions in front when its recipients differ from the current ticks.
 */
export function queuedDraftTarget(room: Room, draft: QueuedDraft, memberId?: string): { memberId?: string; text: string } {
  const text = restoredText(draft)
  const to = room.members.filter((m) => draft.to?.includes(m.id))
  if (!to.length || room.members.length < 2) return { memberId, text }
  const ids = to.map((m) => m.id)
  if (memberId && sameSet(ids, [memberId])) return { memberId, text }
  if (sameSet(composerRecipients(room, text), ids)) return { text }
  return { text: `${to.map((m) => `@${m.handle}`).join(', ')} ${text.trimStart()}` }
}

/**
 * The pane composer a stop from outside the composers (the header) may restore into: the
 * stopped agent's own pane, but only while the panes are on screen. Otherwise the room
 * composer, which every layout shows.
 */
export function stopRestorePane(room: Room, memberId: string | undefined, layout: RoomLayout): string | undefined {
  return memberId && room.members.length > 1 && layout === 'panes' && room.members.some((m) => m.id === memberId) ? memberId : undefined
}

/** Puts taken-back queued messages into the composers that send them to their original recipients. */
export function restoreQueued(room: Room, items: QueuedDraft[], memberId?: string): void {
  const byKey = new Map<string, Array<{ text: string; attachments: Attachment[] }>>()
  for (const item of items) {
    const target = queuedDraftTarget(room, item, memberId)
    const key = composerDraftKey(room.id, target.memberId)
    byKey.set(key, [...(byKey.get(key) ?? []), { text: target.text, attachments: item.attachments }])
  }
  for (const [key, list] of byKey) composerDrafts.restore(key, list)
}
