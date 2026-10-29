import type { Attachment } from '@shared/types'
import { attachmentSrc, isImage } from '../lib/composer'
import { act, useApp } from '../store'
import { Icon } from './Icon'

/** Attached files above the text: images as thumbnail tiles, other files as chips, and a
 *  spinner tile for every file that is still being saved. */
export function ComposerAttachments({ roomId, attachments, saving, onRemove }: { roomId: string; attachments: Attachment[]; saving: number; onRemove(path: string): void }) {
  if (!attachments.length && !saving) return null
  const open = (a: Attachment): void => void act(() => useApp.getState().openLink(a.path, { roomId }))
  return (
    <div className="cmp-attachments">
      {attachments.map((a) =>
        isImage(a) ? (
          <div key={a.path} className="cmp-thumb">
            <button className="cmp-thumb-open" title={`Preview ${a.name}`} onClick={() => open(a)}>
              <img src={attachmentSrc(roomId, a.path)} alt={a.name} draggable={false} />
            </button>
            <button className="cmp-thumb-remove" title={`Remove ${a.name}`} aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.path)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ) : (
          <span key={a.path} className="cmp-file">
            <button className="cmp-file-open" title={`Preview ${a.name}`} onClick={() => open(a)}>
              <Icon name="file" size={13} />
              <span>{a.name}</span>
            </button>
            <button className="cmp-file-remove" title={`Remove ${a.name}`} aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.path)}>
              <Icon name="x" size={11} />
            </button>
          </span>
        )
      )}
      {Array.from({ length: saving }, (_, i) => (
        <div key={`saving-${i}`} className="cmp-thumb cmp-thumb-saving" role="status" aria-label="Saving attachment">
          <span className="spinner" />
        </div>
      ))}
    </div>
  )
}
