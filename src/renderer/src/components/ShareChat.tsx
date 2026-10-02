import { useState } from 'react'
import type { Room } from '@shared/types'
import { act, useApp } from '../store'
import { Icon } from './Icon'
import { Popover } from './MemberControls'

export function ShareChat({ room }: { room: Room }) {
  const platform = useApp((s) => s.platform)
  const [working, setWorking] = useState(false)

  const run = async (action: 'copy' | 'markdown' | 'zip' | 'share', close: () => void): Promise<void> => {
    if (working) return
    setWorking(true)
    close()
    try {
      await act(() => window.iface.exportChat(room.id, action), (result) => {
        if (result.action === 'canceled') return undefined
        const note = result.missingAttachments
          ? ` ${result.missingAttachments} missing attachment${result.missingAttachments === 1 ? '' : 's'} listed in the Markdown.`
          : ''
        if (result.action === 'copied') return `Chat text copied as Markdown. Use ZIP to share attachments too.${note}`
        if (result.action === 'shared') return `Choose an app in the macOS share menu.${note}`
        return `Chat saved to ${result.path}.${note}`
      })
    } finally {
      setWorking(false)
    }
  }

  return (
    <Popover
      align="right"
      button={(open, toggle) => (
        <button className={`chat-share-btn ${open ? 'on' : ''}`} onClick={toggle} disabled={working} aria-label="Share chat" title="Share or export the complete chat">
          <Icon name="share" size={15} />
          <span>{working ? 'Exporting…' : 'Share'}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="chat-share-menu">
          <div className="menu-title">Share this chat</div>
          <p className="chat-share-note">Includes messages, recorded thinking, tool activity and file changes.</p>
          <button className="menu-item" onClick={() => void run('copy', close)}>
            <span className="mi-label">Copy Markdown</span>
            <span className="mi-desc">Full text; use ZIP to include attachment files</span>
          </button>
          <button className="menu-item" onClick={() => void run('markdown', close)}>
            <span className="mi-label">Save Markdown…</span>
            <span className="mi-desc">A .md file with attachments beside it</span>
          </button>
          <button className="menu-item" onClick={() => void run('zip', close)}>
            <span className="mi-label">Save complete chat ZIP…</span>
            <span className="mi-desc">Markdown, screenshots and files in one package</span>
          </button>
          {platform === 'darwin' && (
            <button className="menu-item" onClick={() => void run('share', close)}>
              <span className="mi-label">Share via macOS…</span>
              <span className="mi-desc">Choose AirDrop, Mail or another available app</span>
            </button>
          )}
        </div>
      )}
    </Popover>
  )
}
