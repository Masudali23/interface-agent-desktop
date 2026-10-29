import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Attachment, type Message, type Room } from '@shared/types'
import { parseMentions } from '@shared/mentions'
import { activeToken, ATTACHMENT_ONLY_TEXT, attachmentSrc, busyRecipients, composerKeyAction, composerPlaceholder, insertTrigger, listNames, oneLine, outgoingText, queuedAsCommand, queuedDraftTarget, queuedMessages, restoreQueued, stopRestorePane } from '../src/renderer/src/lib/composer'
import { composerDraftKey } from '../src/renderer/src/lib/agentPanes'
import { ComposerDrafts, composerDrafts } from '../src/renderer/src/lib/composerDrafts'

const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })

const user = (id: string, extra: Partial<Message> = {}): Message => ({ id, author: 'user', createdAt: 1, text: id, blocks: [], status: 'done', ...extra })
const image: Attachment = { name: 'shot.png', path: '/p/.collab/r/attachments/shot 1.png', mime: 'image/png', size: 10 }
const doc: Attachment = { name: 'notes.md', path: '/p/notes.md', mime: 'text/markdown', size: 10 }

describe('composer keys', () => {
  it('sends on Enter and leaves Shift+Enter to the textarea', () => {
    expect(composerKeyAction(key('Enter'), 'darwin', false)).toBe('send')
    expect(composerKeyAction(key('Enter'), 'darwin', true)).toBe('send')
    expect(composerKeyAction(key('Enter', { shiftKey: true }), 'darwin', true)).toBeUndefined()
    expect(composerKeyAction(key('Enter', { altKey: true }), 'linux', true)).toBeUndefined()
    expect(composerKeyAction(key('a'), 'linux', true)).toBeUndefined()
  })

  it('queues with Cmd+Enter on macOS and Ctrl+Enter on Linux only while busy', () => {
    expect(composerKeyAction(key('Enter', { metaKey: true }), 'darwin', true)).toBe('queue')
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), 'linux', true)).toBe('queue')
    expect(composerKeyAction(key('Enter', { metaKey: true }), 'darwin', false)).toBe('send')
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), 'linux', false)).toBe('send')
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), 'darwin', true)).toBeUndefined()
    expect(composerKeyAction(key('Enter', { metaKey: true }), 'linux', true)).toBeUndefined()
  })

  it('stops with a plain Escape only while busy', () => {
    expect(composerKeyAction(key('Escape'), 'darwin', true)).toBe('stop')
    expect(composerKeyAction(key('Escape'), 'darwin', false)).toBeUndefined()
    expect(composerKeyAction(key('Escape', { shiftKey: true }), 'linux', true)).toBeUndefined()
  })
})

describe('composer placeholder', () => {
  it('matches Claude desktop when idle and explains queueing when busy', () => {
    expect(composerPlaceholder({ platform: 'darwin', busy: false, team: false, names: ['Claude'] })).toBe('Type / for commands')
    expect(composerPlaceholder({ platform: 'darwin', busy: false, team: true, names: ['Claude', 'GPT'] })).toBe('Message Claude and GPT · @ to mention, / for commands')
    expect(composerPlaceholder({ platform: 'darwin', busy: true, team: true, names: ['Claude', 'GPT'] })).toBe('↵ to send, ⌘↵ to queue for later')
    expect(composerPlaceholder({ platform: 'linux', busy: true, team: false, names: ['Claude'] })).toBe('Enter to send, Ctrl+Enter to queue for later')
  })

  it('names the agent in a pane composer', () => {
    expect(composerPlaceholder({ platform: 'linux', busy: false, team: true, names: ['GPT'], memberName: 'GPT' })).toBe('Message GPT…')
    expect(composerPlaceholder({ platform: 'darwin', busy: true, team: true, names: ['GPT'], memberName: 'GPT' })).toBe('↵ to send, ⌘↵ to queue for later')
  })

  it('lists names in plain English', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['A'])).toBe('A')
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C')
  })
})

describe('mention and command triggers', () => {
  it('finds the token before the cursor; commands only at the start', () => {
    expect(activeToken('look at @src/ma', 15)).toEqual({ start: 8, token: '@src/ma' })
    expect(activeToken('/rev', 4)).toEqual({ start: 0, token: '/rev' })
    expect(activeToken('see /rev', 8)).toBeUndefined()
    expect(activeToken('mail@host', 9)).toBeUndefined()
    expect(activeToken('/rev', -1)).toBeUndefined()
  })

  it('inserts @ at the cursor with a separating space', () => {
    expect(insertTrigger('', 0, '@')).toEqual({ text: '@', caret: 1 })
    expect(insertTrigger('fix this', 8, '@')).toEqual({ text: 'fix this @', caret: 10 })
    expect(insertTrigger('fix  this', 4, '@')).toEqual({ text: 'fix @ this', caret: 5 })
    const at = insertTrigger('fix this', 8, '@')
    expect(activeToken(at.text, at.caret)).toEqual({ start: 9, token: '@' })
  })

  it('starts a command at the beginning so the command menu opens', () => {
    expect(insertTrigger('', 0, '/')).toEqual({ text: '/', caret: 1 })
    expect(insertTrigger('  the bug', 3, '/')).toEqual({ text: '/the bug', caret: 1 })
    expect(insertTrigger('/review', 4, '/')).toEqual({ text: '/review', caret: 1 })
    const cmd = insertTrigger('the bug', 0, '/')
    expect(activeToken(cmd.text, cmd.caret)).toEqual({ start: 0, token: '/' })
  })
})

describe('queued tray', () => {
  it('lists queued user messages, per agent in a pane', () => {
    const messages = [
      user('a', { queued: true, to: ['m1'] }),
      user('b', { to: ['m1'] }),
      user('c', { queued: true, to: ['m2'] }),
      { ...user('d', { queued: true }), author: 'm1' }
    ]
    expect(queuedMessages(messages).map((m) => m.id)).toEqual(['a', 'c'])
    expect(queuedMessages(messages, 'm1').map((m) => m.id)).toEqual(['a'])
    expect(queuedMessages(messages, 'm3')).toEqual([])
  })

  it('shows one line of text and serves thumbnails from the attachment protocol', () => {
    expect(oneLine('  first\n\nsecond\tthird ')).toBe('first second third')
    expect(attachmentSrc('room-1', image.path)).toBe('iface://attachment/room-1/shot%201.png')
  })
})

describe('composer drafts', () => {
  it('keeps the draft while files save and hands it over once', () => {
    const drafts = new ComposerDrafts()
    drafts.setText('k', 'hello')
    drafts.startSaving('k', 1)
    expect(drafts.take('k')).toBeUndefined()
    drafts.addAttachment('k', image)
    drafts.finishSaving('k')
    expect(drafts.take('k')).toEqual({ text: 'hello', attachments: [image], saving: 0 })
    expect(drafts.take('k')).toBeUndefined()
  })

  it('restores taken-back messages after the current text without duplicate files', () => {
    const drafts = new ComposerDrafts()
    let calls = 0
    drafts.subscribe('k', () => calls++)
    drafts.setText('k', 'typing ')
    drafts.addAttachment('k', image)
    drafts.restore('k', [{ text: ' queued one ', attachments: [image, doc] }, { text: 'queued two', attachments: [] }])
    expect(drafts.get('k')).toEqual({ text: 'typing\n\nqueued one\n\nqueued two', attachments: [image, doc], saving: 0 })
    drafts.restore('k', [])
    expect(calls).toBe(3)
  })
})

const team = (extra: Partial<Room> = {}): Room => ({
  id: 'team', title: 'Team', folder: '/p', kind: 'team', createdAt: 0, updatedAt: 0,
  members: [
    { id: 'c', handle: 'claude', name: 'Claude', provider: 'claude', color: '#c96', accountId: 'a', settings: DEFAULT_SETTINGS },
    { id: 'g', handle: 'gpt', name: 'GPT', provider: 'codex', color: '#396', accountId: 'b', settings: DEFAULT_SETTINGS }
  ],
  autoRelay: true, maxHops: 6, isolation: false, sessions: {}, messages: [], ...extra
})

describe('busy recipients', () => {
  it('counts only the agents this composer addresses', () => {
    const statuses = { c: { status: 'working' as const }, g: { status: 'idle' as const } }
    expect(busyRecipients(['g'], statuses)).toEqual([])
    expect(busyRecipients(['c', 'g'], statuses)).toEqual(['c'])
    expect(busyRecipients(['c'], undefined)).toEqual([])
  })
})

describe('taking queued messages back', () => {
  it('keeps a message addressed only to a pane in that pane', () => {
    expect(queuedDraftTarget(team(), { text: 'fix the CSS', attachments: [], to: ['g'] }, 'g')).toEqual({ memberId: 'g', text: 'fix the CSS' })
  })

  it('returns a single-agent message to the room composer with a mention when the ticks would send it wider', () => {
    const room = team()
    const target = queuedDraftTarget(room, { text: 'fix the CSS', attachments: [], to: ['g'] })
    expect(target).toEqual({ text: '@gpt fix the CSS' })
    expect(parseMentions(target.text, room.members)).toEqual(['g'])
  })

  it('leaves the text alone when the current ticks or its own mentions already match', () => {
    expect(queuedDraftTarget(team({ active: ['g'] }), { text: 'fix it', attachments: [], to: ['g'] })).toEqual({ text: 'fix it' })
    expect(queuedDraftTarget(team(), { text: 'both of you', attachments: [], to: ['c', 'g'] })).toEqual({ text: 'both of you' })
    expect(queuedDraftTarget(team(), { text: '@gpt hi', attachments: [], to: ['g'] })).toEqual({ text: '@gpt hi' })
  })

  it('moves a message for several agents from a pane to the room composer, addressed to all of them', () => {
    const room = team({ active: ['c'] })
    const target = queuedDraftTarget(room, { text: 'review', attachments: [], to: ['c', 'g'] }, 'g')
    expect(target.memberId).toBeUndefined()
    expect(parseMentions(target.text, room.members)?.sort()).toEqual(['c', 'g'])
  })

  it('restores into the matching composers', () => {
    const room = team()
    restoreQueued(room, [
      { text: 'only gpt', attachments: [image], to: ['g'] },
      { text: 'everyone', attachments: [], to: ['c', 'g'] }
    ], 'g')
    expect(composerDrafts.get(composerDraftKey('team', 'g'))).toEqual({ text: 'only gpt', attachments: [image], saving: 0 })
    expect(composerDrafts.get(composerDraftKey('team')).text).toBe('everyone')
  })
})

describe('queued commands and attachment-only messages', () => {
  it('brings an attachment-only message back without the stand-in text', () => {
    expect(queuedDraftTarget(team({ active: ['g'] }), { text: ATTACHMENT_ONLY_TEXT, attachments: [image], to: ['g'] })).toEqual({ text: '' })
    expect(queuedDraftTarget(team(), { text: ATTACHMENT_ONLY_TEXT, attachments: [image], to: ['g'] }).text.trim()).toBe('@gpt')
    expect(queuedDraftTarget(team(), { text: ATTACHMENT_ONLY_TEXT, attachments: [], to: ['c', 'g'] })).toEqual({ text: ATTACHMENT_ONLY_TEXT })
  })

  it('sends a taken-back command addressed with mentions as the command itself', () => {
    const room = team()
    const target = queuedDraftTarget(room, { text: '/compact', attachments: [], to: ['c'] })
    expect(target.text).toBe('@claude /compact')
    expect(parseMentions(target.text, room.members)).toEqual(['c'])
    expect(outgoingText(target.text, room.members)).toBe('/compact')
    expect(outgoingText('@claude, @gpt /review focus on auth', room.members)).toBe('/review focus on auth')
  })

  it('leaves ordinary messages and paths alone', () => {
    const { members } = team()
    expect(outgoingText('@claude fix the CSS', members)).toBe('@claude fix the CSS')
    expect(outgoingText('@claude /src/app.ts is broken', members)).toBe('@claude /src/app.ts is broken')
    expect(outgoingText('@nobody /compact', members)).toBe('@nobody /compact')
    expect(outgoingText('/compact', members)).toBe('/compact')
  })

  it('knows which queued messages run as commands and cannot be sent now', () => {
    const room = team()
    expect(queuedAsCommand(room, { text: '/compact', to: ['c'] })).toBe(true)
    expect(queuedAsCommand(room, { text: '/review', to: ['g'] })).toBe(true)
    expect(queuedAsCommand(room, { text: '/whatever', to: ['g'] })).toBe(false)
    expect(queuedAsCommand(room, { text: 'add tests too', to: ['c'] })).toBe(false)
  })
})

describe('stopping from the header', () => {
  it('restores into the room composer unless the agent panels are showing', () => {
    expect(stopRestorePane(team(), 'c', 'chat')).toBeUndefined()
    expect(stopRestorePane(team(), 'c', 'panes')).toBe('c')
    expect(stopRestorePane(team(), undefined, 'panes')).toBeUndefined()
    expect(stopRestorePane(team({ members: team().members.slice(0, 1) }), 'c', 'panes')).toBeUndefined()
  })
})
