// Actions several parts of the UI share.

import { act, useApp } from '../store'
import { composerDraftKey, readRoomLayout } from './agentPanes'
import { composerDrafts } from './composerDrafts'
import { restoredText, restoreQueued, stopRestorePane } from './composer'

/** Stops one agent (or every agent) from outside a composer, such as the session header, and
 *  puts its queued messages back into a composer that is on screen, so nothing typed is lost. */
export async function stopAgents(roomId: string, memberId?: string): Promise<void> {
  const restored = await act(() => window.iface.stop(roomId, memberId))
  if (!restored?.length) return
  const room = useApp.getState().roomData[roomId]
  if (room) restoreQueued(room, restored, stopRestorePane(room, memberId, readRoomLayout(room.id)))
  else composerDrafts.restore(composerDraftKey(roomId), restored.map((item) => ({ text: restoredText(item), attachments: item.attachments })))
}
