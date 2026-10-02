import { describe, expect, it } from 'vitest'
import { codexFileChange, editedPaths, latestFileActivity } from '../src/shared/changes'
import { parseUnifiedDiff } from '../src/shared/diff'
import type { Block, Message } from '../src/shared/types'

function editBlock(changes: unknown[]): Block {
  return { kind: 'tool', id: 'edit', name: 'Edit files', input: { changes }, status: 'done' }
}

describe('Codex file change normalization', () => {
  it('converts added raw content to one added-file patch with accurate counts and line numbers', () => {
    const change = codexFileChange({ path: 'src/new.ts', kind: 'add', diff: 'first\nsecond\n' })!
    expect(change).toMatchObject({ path: 'src/new.ts', kind: 'add' })
    const [file] = parseUnifiedDiff(change.diff)
    expect(file).toMatchObject({ path: 'src/new.ts', status: 'added', added: 2, removed: 0 })
    expect(file.hunks[0].lines).toEqual([
      { kind: 'add', text: 'first', newLine: 1 },
      { kind: 'add', text: 'second', newLine: 2 }
    ])
  })

  it('converts deleted raw content to a deleted-file patch, including a missing final newline', () => {
    const change = codexFileChange({ path: 'src/old.ts', kind: { type: 'delete' }, diff: 'first\nlast' })!
    const [file] = parseUnifiedDiff(change.diff)
    expect(file).toMatchObject({ path: 'src/old.ts', status: 'deleted', added: 0, removed: 2 })
    expect(file.hunks[0].lines).toEqual([
      { kind: 'remove', text: 'first', oldLine: 1 },
      { kind: 'remove', text: 'last', oldLine: 2 },
      { kind: 'note', text: '\\ No newline at end of file' }
    ])
  })

  it.each(['add', 'delete'] as const)('treats header-looking %s contents as literal file lines', (kind) => {
    const raw = 'diff --git a/fake b/fake\n--- a/fake\n+++ b/fake\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'
    const change = codexFileChange({ path: 'fixtures/patch.txt', kind, diff: raw })!
    const files = parseUnifiedDiff(change.diff)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'fixtures/patch.txt', status: kind === 'add' ? 'added' : 'deleted', added: kind === 'add' ? 7 : 0, removed: kind === 'delete' ? 7 : 0 })
    expect(files[0].hunks[0].lines.map((line) => line.text)).toEqual(raw.trimEnd().split('\n'))
    expect(files[0].hunks[0].lines.every((line) => line.kind === (kind === 'add' ? 'add' : 'remove'))).toBe(true)
  })

  it.each(['add', 'delete'] as const)('preserves an explicitly empty %s file without inventing content', (kind) => {
    const change = codexFileChange({ path: 'empty.txt', kind, diff: '' })!
    expect(change.diff).not.toBe('')
    const files = parseUnifiedDiff(change.diff)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'empty.txt', status: kind === 'add' ? 'added' : 'deleted', added: 0, removed: 0, hunks: [] })
  })

  it.each([{ kind: 'add', path: 'b/file.ts' }, { kind: 'delete', path: 'a/file.ts' }] as const)('preserves the literal directory in $kind $path', ({ kind, path }) => {
    const change = codexFileChange({ path, kind, diff: 'content\n' })!
    expect(change.path).toBe(path)
    const files = parseUnifiedDiff(change.diff)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path, status: kind === 'add' ? 'added' : 'deleted', added: kind === 'add' ? 1 : 0, removed: kind === 'delete' ? 1 : 0 })
  })

  it('leaves existing update patches unchanged for flattened, native, and older records', () => {
    const diff = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2 +2 @@\n-old\n+new\n'
    for (const kind of ['update', { type: 'update' }, undefined]) {
      const change = codexFileChange({ path: 'file.ts', kind, diff })!
      expect(change).toEqual({ path: 'file.ts', kind: 'update', diff })
      expect(parseUnifiedDiff(change.diff)[0]).toMatchObject({ path: 'file.ts', added: 1, removed: 1 })
    }
  })

  it('retains rename destinations and source paths for native and flattened events', () => {
    const diff = '@@ -1 +1 @@\n-old\n+new\n'
    for (const input of [
      { path: 'old.ts', kind: { type: 'update', move_path: 'new.ts' }, diff },
      { path: 'old.ts', kind: 'update', move_path: 'new.ts', diff },
      { path: 'old.ts', kind: 'update', movePath: 'new.ts', diff },
      { path: 'new.ts', kind: 'update', oldPath: 'old.ts', diff }
    ]) {
      expect(codexFileChange(input)).toEqual({ path: 'new.ts', oldPath: 'old.ts', kind: 'update', diff })
      expect(editedPaths(editBlock([input]))).toEqual(['new.ts'])
    }
    expect(codexFileChange({ path: 'same.ts', kind: { type: 'update', move_path: 'same.ts' }, diff: '' })).toEqual({ path: 'same.ts', kind: 'update', diff: '' })
  })

  it('preserves file activity when contents are absent or invalid', () => {
    for (const kind of ['add', 'delete', 'update'] as const) {
      for (const diff of [undefined, null, 123, {}]) {
        expect(codexFileChange({ path: 'known.ts', kind, diff })).toEqual({ path: 'known.ts', kind, diff: '' })
      }
    }
  })

  it('ignores malformed records safely', () => {
    const malformed = [null, undefined, 1, 'path.ts', [], {}, { path: '' }, { path: 1 }, { path: 'bad\0path' }, { path: 'valid', kind: false }, { path: 'valid', kind: {} }, { path: 'valid', kind: 'unknown' }]
    for (const input of malformed) expect(codexFileChange(input)).toBeUndefined()
    expect(editedPaths(editBlock([...malformed, { path: 'valid.ts', kind: 'update' }]))).toEqual(['valid.ts'])
  })

  it('extracts rename activity without reading or generating a patch', () => {
    const change = {
      path: 'before.ts', kind: { type: 'update', move_path: 'after.ts' },
      get diff(): string { throw new Error('Activity extraction must not read the patch') }
    }
    const block = editBlock([change])
    expect(editedPaths(block)).toEqual(['after.ts'])
    const message = { id: 'message', blocks: [block] } as Message
    expect(latestFileActivity(message)).toEqual({ key: 'message:edit:after.ts', path: 'after.ts' })
    expect(editedPaths({ ...block, status: 'error' } as Block)).toEqual([])
  })
})
