import type { Message, Room } from '@shared/types'
import { attachmentSrc, isImage, listNames, oneLine, queuedAsCommand, restoreQueued } from '../lib/composer'
import { act } from '../store'
import { Icon } from './Icon'

/** Takes a queued message back for editing, into the composer that sends it to the same agents. */
async function editQueued(room: Room, messageId: string, memberId?: string): Promise<void> {
  const draft = await act(() => window.iface.cancelQueued(room.id, messageId))
  if (draft) restoreQueued(room, [draft], memberId)
}

/** Messages sent with "queue for later" that wait for the current turn to finish. */
export function QueuedTray({ room, queued, memberId }: { room: Room; queued: Message[]; memberId?: string }) {
  if (!queued.length) return null
  const team = room.members.length > 1
  return (
    <div className="cmp-queue" role="list" aria-label="Queued messages">
      {queued.map((m) => {
        const images = (m.attachments ?? []).filter(isImage)
        const files = (m.attachments?.length ?? 0) - images.length
        const recipients = team && !memberId ? room.members.filter((x) => m.to?.includes(x.id)).map((x) => x.name) : []
        return (
          <div key={m.id} className="cmp-queue-row" role="listitem">
            <Icon name="clock" size={13} className="cmp-queue-icon" />
            <span className="cmp-queue-label">Queued</span>
            <span className="cmp-queue-text" title={m.text}>{oneLine(m.text)}</span>
            {images.slice(0, 3).map((a) => <img key={a.path} className="cmp-queue-thumb" src={attachmentSrc(room.id, a.path)} alt={a.name} />)}
            {images.length > 3 && <span className="cmp-queue-count">+{images.length - 3}</span>}
            {files > 0 && <span className="cmp-queue-count"><Icon name="paperclip" size={11} />{files}</span>}
            {recipients.length > 0 && <span className="cmp-queue-to">to {listNames(recipients)}</span>}
            <span className="cmp-queue-actions">
              {queuedAsCommand(room, m) ? (
                <span className="cmp-queue-note" title="Commands run after the current turn finishes">Runs next</span>
              ) : (
                <button className="cmp-queue-send" onClick={() => void act(() => window.iface.sendQueuedNow(room.id, m.id))} title="Send now and join the current turn">
                  Send now
                </button>
              )}
              <button className="cmp-icon-btn" onClick={() => void editQueued(room, m.id, memberId)} title="Edit: put it back into the composer" aria-label="Edit queued message">
                <Icon name="pencil" size={13} />
              </button>
              <button className="cmp-icon-btn" onClick={() => void act(() => window.iface.cancelQueued(room.id, m.id))} title="Remove from the queue" aria-label="Remove queued message">
                <Icon name="x" size={13} />
              </button>
            </span>
          </div>
        )
      })}
      <div className="cmp-queue-hint">Runs after the current turn</div>
    </div>
  )
}
