import { describe, expect, it } from 'vitest'
import { createRecordedChangesSelector } from '../src/shared/recordedChanges'
import { parseUnifiedDiff } from '../src/shared/diff'
import type { Block, Member, Message, Room } from '../src/shared/types'

const tool = (changes: unknown[]): Block => ({ kind: 'tool', id: 'edit', name: 'Edit files', status: 'done', input: { changes } })
const message = (blocks: Block[], extra: Partial<Message> = {}): Message => ({ id: 'reply', author: 'gpt', authorName: 'GPT', createdAt: 1, text: '', status: 'streaming', blocks, ...extra })
const room = (...messages: Message[]): Pick<Room, 'folder' | 'members' | 'messages'> => ({ folder: '/project', members: [], messages })

describe('recorded chat changes', () => {
  it('shows every raw Codex add/delete line, including patch-like content, with correct counts', () => {
    const content = 'import value\n--- text\n+++ text\n@@ -1 +1 @@\ndiff --git a/fake b/fake\n'
    const files = createRecordedChangesSelector()(room(message([tool([
      { path: '/project/new.ts', kind: 'add', diff: content },
      { path: '/project/gone.ts', kind: 'delete', diff: content }
    ])])))
    expect(files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['new.ts', 'added', 5, 0], ['gone.ts', 'deleted', 0, 5]
    ])
    for (const file of files) {
      const parsed = parseUnifiedDiff(file.edits[0].diff)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].hunks[0].lines.map((line) => line.text)).toEqual(content.trimEnd().split('\n'))
      expect(parsed[0].hunks[0].lines.every((line) => line.kind === (file.status === 'added' ? 'add' : 'remove'))).toBe(true)
    }
  })

  it('keeps empty files and rename destinations in the list', () => {
    const files = createRecordedChangesSelector()(room(message([tool([
      { path: '/project/empty', kind: 'add', diff: '' },
      { path: '/project/old.ts', kind: 'update', move_path: '/project/new.ts', diff: '@@ -1 +1 @@\n-before\n+after\n' }
    ])])))
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.added, f.removed])).toEqual([
      ['empty', undefined, 'added', 0, 0], ['new.ts', 'old.ts', 'renamed', 1, 1]
    ])
  })

  it('reuses parsed patches when streamed text, tool output, usage or unrelated messages change', () => {
    const select = createRecordedChangesSelector()
    const original = room(message([tool([{ path: '/project/new.ts', kind: 'add', diff: 'hello\n' }])]))
    const first = select(original)
    // Incoming IPC updates have new object identities, even for unchanged tool inputs.
    const updated = structuredClone(original)
    updated.messages[0].text = 'More explanation'
    updated.messages[0].blocks.push({ kind: 'text', id: 'text', text: 'Streaming' })
    const block = updated.messages[0].blocks[0]
    if (block.kind === 'tool') block.output = 'Longer progress log'
    updated.messages.push(message([], { id: 'other', text: 'Unrelated reply' }))
    expect(select(updated)).toBe(first)
    expect(select(updated, 'reply')).toBe(first)
  })

  it('refreshes same-length patch and tool-input changes, undo labels and removed messages', () => {
    const select = createRecordedChangesSelector()
    const original = room(message([], { diff: '@@ -1 +1 @@\n-old\n+new\n' }))
    const first = select(original)
    const changed = room(message([], { diff: '@@ -1 +1 @@\n-old\n+NEW\n' }))
    const second = select(changed)
    expect(second).not.toBe(first)
    expect(second[0].edits[0].diff).toContain('+NEW')
    const undone = select(room(message([], { ...changed.messages[0], undone: true })))
    expect(undone[0].edits[0].undone).toBe(true)
    const a = select(room(message([tool([{ path: 'f', kind: 'add', diff: 'a' }])])))
    const b = select(room(message([tool([{ path: 'f', kind: 'add', diff: 'b' }])])))
    expect(b).not.toBe(a)
    expect(b[0].edits[0].diff).toContain('+b')
    expect(select(room())).toEqual([])
  })

  it('records completed tools, prefers final snapshots and scopes roots on folder boundaries', () => {
    const select = createRecordedChangesSelector()
    const pending = tool([{ path: '/project-other/f', kind: 'add', diff: 'one\n' }])
    if (pending.kind === 'tool') pending.status = 'running'
    expect(select(room(message([pending])))).toEqual([])
    if (pending.kind === 'tool') pending.status = 'done'
    const files = select(room(message([pending])))
    expect(files[0].path).toBe('/project-other/f')
    const snapshot = select(room(message([pending], { diff: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n' })))
    expect(snapshot).toHaveLength(1)
    expect([snapshot[0].path, snapshot[0].added, snapshot[0].removed]).toEqual(['f', 1, 1])
    const ownCopy = room(message([tool([{ path: '/copy/f', kind: 'add', diff: 'x\n' }])]))
    ownCopy.members = [{ id: 'gpt', worktree: { path: '/copy' } } as Member]
    expect(select(ownCopy)[0].path).toBe('f')
    ownCopy.members = []
    expect(select(ownCopy)[0].path).toBe('/copy/f')
  })

  it('keeps a created file marked added after later Codex updates', () => {
    const history = room(
      message([tool([{ path: '/project/new.ts', kind: 'add', diff: 'first\n' }])], { id: 'create', createdAt: 1 }),
      message([tool([{ path: '/project/new.ts', kind: 'update', diff: '@@ -1 +1 @@\n-first\n+second\n' }])], { id: 'update', createdAt: 2 })
    )
    const select = createRecordedChangesSelector()
    const files = select(history)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'added', added: 2, removed: 1 })
    expect(files[0].edits.map((edit) => edit.messageId)).toEqual(['create', 'update'])
    expect(select(history, 'update')[0]).toMatchObject({ path: 'new.ts', status: 'modified', added: 1, removed: 1 })
  })

  it('retains a Codex rename in aggregate metadata without labeling later edits as renames', () => {
    const history = room(
      message([tool([{ path: '/project/old.ts', kind: { type: 'update', move_path: '/project/new.ts' }, diff: '@@ -1 +1 @@\n-before\n+renamed\n' }])], { id: 'rename', createdAt: 1 }),
      message([tool([{ path: '/project/new.ts', kind: 'update', diff: '@@ -1 +1 @@\n-renamed\n+later\n' }])], { id: 'update', createdAt: 2 })
    )
    const select = createRecordedChangesSelector()
    const files = select(history)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'renamed', oldPath: 'old.ts', added: 2, removed: 2 })
    expect(files[0].edits[0].oldPath).toBe('old.ts')
    expect(files[0].edits[1].oldPath).toBeUndefined()
    const latest = select(history, 'update')[0]
    expect(latest.status).toBe('modified')
    expect(latest.oldPath).toBeUndefined()
    expect(latest.edits[0].oldPath).toBeUndefined()
  })

  it('keeps a create-then-delete history visible and marks its final state deleted', () => {
    const files = createRecordedChangesSelector()(room(
      message([tool([{ path: '/project/temporary.ts', kind: 'add', diff: 'temporary\n' }])], { id: 'create', createdAt: 1 }),
      message([tool([{ path: '/project/temporary.ts', kind: 'delete', diff: 'temporary\n' }])], { id: 'delete', createdAt: 2 })
    ))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'temporary.ts', status: 'deleted', added: 1, removed: 1 })
    expect(files[0].edits.map((edit) => edit.messageId)).toEqual(['create', 'delete'])
  })

  it('marks a deleted and recreated existing file modified', () => {
    const files = createRecordedChangesSelector()(room(
      message([tool([{ path: '/project/replaced.ts', kind: 'delete', diff: 'original\n' }])], { id: 'delete', createdAt: 1 }),
      message([tool([{ path: '/project/replaced.ts', kind: 'add', diff: 'replacement\n' }])], { id: 'recreate', createdAt: 2 })
    ))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'replaced.ts', status: 'modified', added: 1, removed: 1 })
    expect(files[0].oldPath).toBeUndefined()
    expect(files[0].edits.map((edit) => edit.messageId)).toEqual(['delete', 'recreate'])
  })

  it('preserves a snapshot rename when a later snapshot repeats the destination as its old path', () => {
    const rename = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
    const modify = 'diff --git a/new.ts b/new.ts\n--- a/new.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-before\n+after\n'
    expect(parseUnifiedDiff(modify)[0].oldPath).toBe('new.ts')
    const files = createRecordedChangesSelector()(room(
      message([], { id: 'rename', createdAt: 1, diff: rename }),
      message([], { id: 'modify', createdAt: 2, diff: modify })
    ))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'renamed', oldPath: 'old.ts', added: 1, removed: 1 })
    expect(files[0].edits[0].oldPath).toBe('old.ts')
    expect(files[0].edits[1].oldPath).toBeUndefined()
  })
})
