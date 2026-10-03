import { parseMentions } from '@shared/mentions'
import { defaultRecipients, type Message, type Room } from '@shared/types'

/** Pane messages still belong to the shared room; mentions there are ordinary text. */
export function composerRecipients(room: Room, text: string, memberId?: string): string[] {
  if (memberId) return room.members.some((m) => m.id === memberId) ? [memberId] : []
  return parseMentions(text, room.members) ?? defaultRecipients(room)
}

export function paneMessages(messages: Message[], memberId: string): Message[] {
  return messages.filter((message) =>
    message.author === memberId ||
    (message.author === 'user' && (!message.to?.length || message.to.includes(memberId))) ||
    message.handoff?.to === memberId
  )
}

export function composerDraftKey(roomId: string, memberId?: string): string {
  return JSON.stringify([roomId, memberId ?? null])
}

export type RoomLayout = 'chat' | 'panes'

export function readRoomLayout(roomId: string): RoomLayout {
  try { return localStorage.getItem(`iface.roomLayout.${roomId}`) === 'panes' ? 'panes' : 'chat' }
  catch { return 'chat' }
}

export function saveRoomLayout(roomId: string, layout: RoomLayout): void {
  try { localStorage.setItem(`iface.roomLayout.${roomId}`, layout) } catch { /* Preference is optional. */ }
}
