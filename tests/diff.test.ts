import { describe, expect, it } from 'vitest'
import { createTwoFilesPatch } from 'diff'
import { decodeGitPath, parseUnifiedDiff, splitDiffLines } from '../src/shared/diff'

describe('diff review', () => {
  it('keeps correct old/new line numbers and recognizes added code beginning with ++', () => {
    const [file] = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +20,3 @@ fn\n keep\n-old\n+++counter\n tail\n')
    expect([file.path, file.added, file.removed]).toEqual(['a.ts', 1, 1])
    expect(file.hunks[0].lines).toEqual([
      { kind: 'context', text: 'keep', oldLine: 10, newLine: 20 },
      { kind: 'remove', text: 'old', oldLine: 11 },
      { kind: 'add', text: '++counter', newLine: 21 },
      { kind: 'context', text: 'tail', oldLine: 12, newLine: 22 }
    ])
  })
  it('separates renamed, deleted, and binary files', () => {
    const files = parseUnifiedDiff('diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\n')
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([['new name.ts', 'renamed', false], ['gone.ts', 'deleted', false], ['icon.png', 'modified', true]])
    expect(files[0].oldPath).toBe('old name.ts')
  })
  it('decodes Git quoted UTF-8 paths and escaped tabs', () => {
    expect(decodeGitPath('"a/\\303\\251\\tfile.ts"')).toBe('a/é\tfile.ts')
    const [file] = parseUnifiedDiff('diff --git "a/a\\tb" "b/a\\tb"\n--- "a/a\\tb"\n+++ "b/a\\tb"\n@@ -1 +1 @@\n-a\n+b')
    expect(file.path).toBe('a\tb')
  })
  it('pairs replacements without losing unequal additions or no-newline markers', () => {
    const [file] = parseUnifiedDiff('@@ -1,2 +1,3 @@\n-a\n-b\n+x\n+y\n+z\n\\ No newline at end of file', 'snippet.ts')
    const lines = splitDiffLines(file.hunks[0].lines)
    expect(lines.map((row) => [row.left?.text, row.right?.text])).toEqual([['a', 'x'], ['b', 'y'], [undefined, 'z'], ['\\ No newline at end of file', '\\ No newline at end of file']])
  })
  it('preserves a real a/ or b/ directory in recorded edit excerpts', () => {
    for (const path of ['a/component.ts', 'b/component.ts']) {
      const [file] = parseUnifiedDiff(createTwoFilesPatch(path, path, 'before\n', 'after\n'), path)
      expect(file.path).toBe(path)
      expect(file.oldPath).toBe(path)
      expect([file.added, file.removed]).toEqual([1, 1])
    }
  })
  it('separates standard unified patches at the end of each declared hunk', () => {
    const files = parseUnifiedDiff('--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-before\n+after\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-previous\n+next\n')
    expect(files.map((file) => [file.path, file.added, file.removed])).toEqual([['first.ts', 1, 1], ['second.ts', 1, 1]])
    expect(files[1].hunks[0].lines.map((line) => line.text)).toEqual(['previous', 'next'])
  })
  it('preserves ambiguous space-containing names for changes without text headers', () => {
    const path = 'folder b/nested/file.ts'
    const [file] = parseUnifiedDiff(`diff --git a/${path} b/${path}\nold mode 100644\nnew mode 100755\n`)
    expect(file.path).toBe(path)
    expect(file.oldPath).toBe(path)
    expect(file.hunks).toEqual([])
  })
  it('keeps no-newline markers with completed hunks and starts later hunks at their own ranges', () => {
    const [file] = parseUnifiedDiff('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n@@ -8,0 +9,2 @@\n+later\n+last\n')
    expect(file.hunks).toHaveLength(2)
    expect(file.hunks[0].lines.map((line) => line.kind)).toEqual(['remove', 'note', 'add', 'note'])
    expect(file.hunks[1].lines).toEqual([{ kind: 'add', text: 'later', newLine: 9 }, { kind: 'add', text: 'last', newLine: 10 }])
  })
})
