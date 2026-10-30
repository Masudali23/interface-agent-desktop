import { useState } from 'react'
import type { Room } from '@shared/types'
import { act } from '../store'

export type ExportAction = 'copy' | 'markdown' | 'zip' | 'share'

/** Exports the complete chat (copy, save or the macOS share menu) and reports the result
 *  in a toast. `working` stays true until the export has finished. */
export function useChatExport(room: Room): { working: boolean; run: (action: ExportAction) => Promise<void> } {
  const [working, setWorking] = useState(false)
  const run = async (action: ExportAction): Promise<void> => {
    if (working) return
    setWorking(true)
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
  return { working, run }
}

/** Menu rows for sharing or exporting the chat. */
export function ChatExportItems({ platform, working, run, close }: { platform: string; working: boolean; run: (action: ExportAction) => Promise<void>; close: () => void }) {
  const item = (action: ExportAction, label: string, desc: string) => (
    <button className="menu-item" disabled={working} onClick={() => { close(); void run(action) }}>
      <span className="mi-label">{label}</span>
      <span className="mi-desc">{desc}</span>
    </button>
  )
  return (
    <>
      {item('copy', 'Copy as Markdown', 'Full text, recorded thinking, tools and file changes')}
      {item('markdown', 'Save Markdown…', 'A .md file with attachments beside it')}
      {item('zip', 'Save complete chat ZIP…', 'Markdown, screenshots and files in one package')}
      {platform === 'darwin' && item('share', 'Share via macOS…', 'AirDrop, Mail or another available app')}
    </>
  )
}
