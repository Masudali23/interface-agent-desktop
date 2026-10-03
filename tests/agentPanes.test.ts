import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerDraftKey, composerRecipients, paneMessages, readRoomLayout, saveRoomLayout } from '../src/renderer/src/lib/agentPanes'
import { DEFAULT_SETTINGS, type Message, type Room } from '../src/shared/types'
import { ComposerDrafts } from '../src/renderer/src/lib/composerDrafts'

const room: Room = {
  id: 'room', title: 'Example', folder: '/project', kind: 'team', createdAt: 0, updatedAt: 0,
  members: ['gpt', 'claude', 'gpt-2', 'claude-2'].map((handle) => ({ id: handle, handle, name: handle, provider: handle.startsWith('gpt') ? 'codex' : 'claude', color: '#333', accountId: handle, settings: DEFAULT_SETTINGS })),
  autoRelay: true, maxHops: 6, isolation: false, sessions: {}, messages: [], dispatch: 'lead', leadId: 'gpt-2', active: ['gpt-2', 'gpt']
}
const message = (id: string, author: string, extra: Partial<Message> = {}): Message => ({ id, author, createdAt: 0, text: id, blocks: [], status: 'done', ...extra })

afterEach(() => vi.unstubAllGlobals())

describe('connected agent panes', () => {
  it('shows own work, messages addressed to the pane and incoming handoffs in room order', () => {
    const messages = [message('team', 'user', { to: ['gpt', 'gpt-2'] }), message('other-user', 'user', { to: ['claude'] }), message('own', 'gpt'), message('other-work', 'claude'), message('incoming', 'gpt-2', { handoff: { to: 'gpt', text: 'Check this' } }), message('outgoing', 'gpt', { handoff: { to: 'gpt-2', text: 'Checked' } })]
    expect(paneMessages(messages, 'gpt').map((m) => m.id)).toEqual(['team', 'own', 'incoming', 'outgoing'])
    expect(messages).toHaveLength(6)
  })
  it('preserves room routing but fixes pane sends to their agent, even with other handles in text', () => {
    expect(composerRecipients(room, 'Continue')).toEqual(['gpt-2'])
    expect(composerRecipients(room, '@gpt Please review')).toEqual(['gpt'])
    expect(composerRecipients(room, 'Coordinate with @gpt-2 and @claude', 'gpt')).toEqual(['gpt'])
    expect(composerRecipients(room, '@both Check', 'claude')).toEqual(['claude'])
    expect(composerRecipients(room, 'Hello', 'removed')).toEqual([])
    expect(composerRecipients({ ...room, dispatch: 'parallel' }, 'Hello')).toEqual(['gpt-2', 'gpt'])
  })
  it('keeps legacy broadcast messages and streams the original message objects', () => {
    const messages = [message('legacy', 'user'), message('live', 'gpt', { status: 'streaming' })]
    expect(paneMessages(messages, 'gpt')).toEqual(messages)
    expect(paneMessages(messages, 'gpt')[1]).toBe(messages[1])
  })
  it('keeps room and pane draft keys distinct across rooms', () => {
    expect(new Set([composerDraftKey('r'), composerDraftKey('r', 'a'), composerDraftKey('r', 'b'), composerDraftKey('r2', 'a'), composerDraftKey('r:a')]).size).toBe(5)
  })
  it('defaults to shared chat and stores the opt-in per room', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
    expect(readRoomLayout('a')).toBe('chat')
    saveRoomLayout('a', 'panes')
    expect(readRoomLayout('a')).toBe('panes')
    expect(readRoomLayout('b')).toBe('chat')
    saveRoomLayout('a', 'chat')
    expect(readRoomLayout('a')).toBe('chat')
  })
  it('still works when preference storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Unavailable') }, setItem: () => { throw new Error('Unavailable') } })
    expect(readRoomLayout('a')).toBe('chat')
    expect(() => saveRoomLayout('a', 'panes')).not.toThrow()
  })
})

describe('attachment saves across composer lifetimes', () => {
  const attachment = { path: '/example/notes.txt', name: 'notes.txt', mime: 'text/plain', size: 4 }

  it('retains a file that finishes saving while its pane is unmounted', () => {
    const drafts = new ComposerDrafts()
    const key = composerDraftKey('room', 'gpt')
    const previousView = vi.fn()
    const unmount = drafts.subscribe(key, previousView)
    drafts.setText(key, 'Read this file')
    drafts.startSaving(key, 1)
    unmount()
    previousView.mockClear()
    drafts.addAttachment(key, attachment)
    drafts.finishSaving(key)
    expect(previousView).not.toHaveBeenCalled()
    expect(drafts.get(key)).toEqual({ text: 'Read this file', attachments: [attachment], saving: 0 })
  })

  it('updates a remounted composer without overwriting newer text or another pane', () => {
    const drafts = new ComposerDrafts()
    const key = composerDraftKey('room', 'gpt')
    const otherKey = composerDraftKey('room')
    drafts.startSaving(key, 1)
    drafts.setText(otherKey, 'Room draft')
    const remounted = vi.fn()
    drafts.subscribe(key, remounted)
    drafts.setText(key, 'Updated while the file saved')
    drafts.addAttachment(key, attachment)
    drafts.finishSaving(key)
    expect(remounted).toHaveBeenCalledTimes(3)
    expect(drafts.get(key)).toEqual({ text: 'Updated while the file saved', attachments: [attachment], saving: 0 })
    expect(drafts.get(otherKey)).toEqual({ text: 'Room draft', attachments: [], saving: 0 })
  })

  it('waits for concurrent saves and sends all successfully saved files exactly once', () => {
    const drafts = new ComposerDrafts()
    drafts.setText('key', 'Use these files')
    drafts.startSaving('key', 2)
    drafts.startSaving('key', 1)
    drafts.addAttachment('key', attachment)
    drafts.finishSaving('key')
    expect(drafts.take('key')).toBeUndefined()
    // One failed save finishes without an attachment; the last save succeeds.
    drafts.finishSaving('key')
    expect(drafts.take('key')).toBeUndefined()
    const second = { ...attachment, path: '/example/second.txt', name: 'second.txt' }
    drafts.addAttachment('key', second)
    drafts.finishSaving('key')
    expect(drafts.take('key')).toEqual({ text: 'Use these files', attachments: [attachment, second], saving: 0 })
    expect(drafts.take('key')).toBeUndefined()
  })

  it('preserves a removal made after remount while another file is still saving', () => {
    const drafts = new ComposerDrafts()
    const second = { ...attachment, path: '/example/second.txt', name: 'second.txt' }
    drafts.addAttachment('key', attachment)
    drafts.startSaving('key', 1)
    drafts.removeAttachment('key', attachment.path)
    drafts.addAttachment('key', second)
    drafts.finishSaving('key')
    expect(drafts.take('key')?.attachments).toEqual([second])
  })
})
