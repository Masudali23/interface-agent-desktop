import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addWorktree, diffTrees, fileDiff, git, listFiles, mergeWorktree, restoreTree, snapshot, status } from '../src/main/git'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function command(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, args)
  if (result.code) throw new Error(`${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function repo(initial: Record<string, string | Buffer> = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'interface-git-test-'))
  roots.push(root)
  await command(root, 'init', '-b', 'main')
  await command(root, 'config', 'user.name', 'Masudali23')
  await command(root, 'config', 'user.email', 'alimasud2023@gmail.com')
  await command(root, 'config', 'commit.gpgsign', 'false')
  await command(root, 'config', 'core.autocrlf', 'false')
  await command(root, 'config', 'core.filemode', 'true')
  await command(root, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  await command(root, 'config', 'diff.renames', 'true')
  for (const [path, content] of Object.entries(initial)) put(root, path, content)
  if (Object.keys(initial).length) await commit(root)
  return root
}

function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

async function commit(root: string, message = 'Fixture'): Promise<string> {
  await command(root, 'add', '-A')
  await command(root, 'commit', '-m', message)
  return command(root, 'rev-parse', 'HEAD')
}

async function tree(root: string): Promise<string> {
  const result = await snapshot(root)
  expect(result).toMatch(/^[a-f0-9]{40,64}$/)
  return result!
}

function indexBytes(root: string): Buffer { return readFileSync(join(root, '.git', 'index')) }

describe('live git status and diffs', () => {
  it('reports staged and unstaged text, binary, deletions, untracked text and literal Unicode/tab/newline names', async () => {
    const odd = '雪\tline\n[1].txt'
    const root = await repo({ 'tracked.txt': 'old\n', 'gone.txt': 'gone\n', 'binary.bin': Buffer.from([1, 0, 2]), [odd]: 'before\n' })
    put(root, 'tracked.txt', 'staged\n')
    await command(root, 'add', 'tracked.txt')
    put(root, 'tracked.txt', 'unstaged\nextra\n')
    put(root, odd, 'after\n')
    put(root, 'binary.bin', Buffer.from([1, 0, 3]))
    rmSync(join(root, 'gone.txt'))
    put(root, ':literal[?].txt', 'new\nno final newline')
    put(root, '-new.bin', Buffer.from([0, 1]))
    put(root, '.collab/tasks.md', 'hidden')
    const state = await status(root)
    expect(state.error).toBeUndefined()
    expect(state.branch).toBe('main')
    expect(state.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified', staged: true, added: 2, removed: 1 }),
      expect.objectContaining({ path: 'gone.txt', status: 'deleted', added: 0, removed: 1 }),
      expect.objectContaining({ path: 'binary.bin', binary: true, added: undefined, removed: undefined }),
      expect.objectContaining({ path: odd, added: 1, removed: 1 }),
      expect.objectContaining({ path: ':literal[?].txt', status: 'untracked', added: 2, removed: 0, staged: false }),
      expect.objectContaining({ path: '-new.bin', status: 'untracked', binary: true })
    ]))
    expect(state.files.some((file) => file.path.startsWith('.collab'))).toBe(false)
    expect(await fileDiff(root, odd)).toContain('+after')
    expect(await fileDiff(root, ':literal[?].txt')).toContain('+no final newline')
    expect(await fileDiff(root, '-new.bin')).toContain('Binary files')
    expect(await listFiles(root)).toContain(odd)
    expect(await listFiles(root)).not.toContain('.collab/tasks.md')
  })

  it('keeps both names for staged and committed renames without duplicate rows', async () => {
    const old = 'old\t雪.txt'
    const next = 'new\t雪.txt'
    const root = await repo({ [old]: 'one\ntwo\nthree\nfour\nfive\n' })
    const base = await command(root, 'rev-parse', 'HEAD')
    await command(root, 'mv', old, next)
    put(root, next, 'one\ntwo\nthree\nfour\nchanged\n')
    const staged = await status(root)
    expect(staged.error).toBeUndefined()
    expect(staged.files).toHaveLength(1)
    expect(staged.files[0]).toMatchObject({ path: next, oldPath: old, status: 'renamed', staged: true, added: 1, removed: 1 })
    const diff = await fileDiff(root, next)
    expect(diff).toContain('rename from')
    expect(diff).toContain('rename to')
    expect(diff).toContain('+changed')
    expect(await fileDiff(root, next, undefined, old)).toBe(diff)
    await commit(root)
    expect((await status(root, base)).files).toEqual([expect.objectContaining({ path: next, oldPath: old, status: 'renamed', staged: false, added: 1, removed: 1 })])
    expect(await fileDiff(root, next, base)).toContain('rename from')
  })

  it('shows new and deleted files against a supplied base, including staged deletion', async () => {
    const root = await repo({ 'delete.txt': 'deleted content\n', 'keep.txt': 'keep\n' })
    const base = await command(root, 'rev-parse', 'HEAD')
    await command(root, 'rm', 'delete.txt')
    expect(await fileDiff(root, 'delete.txt')).toContain('-deleted content')
    put(root, 'added.txt', 'added content\n')
    await commit(root)
    expect((await status(root, base)).files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'delete.txt', status: 'deleted', added: 0, removed: 1 }),
      expect.objectContaining({ path: 'added.txt', status: 'added', added: 1, removed: 0 })
    ]))
    expect(await fileDiff(root, 'delete.txt', base)).toContain('deleted file mode')
    expect(await fileDiff(root, 'added.txt', base)).toContain('new file mode')
  })

  it('supports a repository with no commits', async () => {
    const root = await repo()
    put(root, 'staged.txt', 'first\n')
    await command(root, 'add', 'staged.txt')
    put(root, 'untracked.txt', 'second\n')
    const state = await status(root)
    expect(state.error).toBeUndefined()
    expect(state.branch).toBe('main')
    expect(state.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'staged.txt', status: 'added', staged: true, added: 1 }),
      expect.objectContaining({ path: 'untracked.txt', status: 'untracked', staged: false, added: 1 })
    ]))
    expect(await fileDiff(root, 'staged.txt')).toContain('+first')
    expect(await fileDiff(root, 'untracked.txt')).toContain('+second')
  })

  it('marks merge conflicts and preserves the filename', async () => {
    const root = await repo({ 'conflict.txt': 'base\n' })
    await command(root, 'checkout', '-b', 'other')
    put(root, 'conflict.txt', 'other\n')
    await commit(root)
    await command(root, 'checkout', 'main')
    put(root, 'conflict.txt', 'main\n')
    await commit(root)
    expect((await git(root, ['merge', 'other'])).code).toBe(1)
    const state = await status(root)
    expect(state.error).toBeUndefined()
    expect(state.files).toEqual([expect.objectContaining({ path: 'conflict.txt', status: 'conflict' })])
    expect(await fileDiff(root, 'conflict.txt')).toContain('<<<<<<< HEAD')
  })

  it('uses literal pathspecs, rejects escaping paths/revisions, and surfaces Git errors', async () => {
    const root = await repo({ 'file[1].txt': 'old\n', 'file1.txt': 'old\n', ':special.txt': 'old\n' })
    put(root, 'file[1].txt', 'literal\n')
    put(root, 'file1.txt', 'unwanted\n')
    put(root, ':special.txt', 'colon\n')
    expect(await fileDiff(root, 'file[1].txt')).toContain('+literal')
    expect(await fileDiff(root, 'file[1].txt')).not.toContain('unwanted')
    expect(await fileDiff(root, ':special.txt')).toContain('+colon')
    await expect(fileDiff(root, '../outside')).rejects.toThrow('inside')
    await expect(fileDiff(root, join(root, 'file1.txt'))).rejects.toThrow('inside')
    await expect(fileDiff(root, '.git/config')).rejects.toThrow('inside')
    await expect(fileDiff(root, 'file1.txt', '--output=oops')).rejects.toThrow('revision')
    await expect(fileDiff(root, 'file1.txt', 'missing-branch')).rejects.toThrow()
    expect((await status(root, 'missing-branch')).error).toBeTruthy()
    symlinkSync(tmpdir(), join(root, 'outside'))
    await expect(fileDiff(root, 'outside/anything')).rejects.toThrow('outside')
  })

  it('scopes paths correctly when the selected folder is below the repository root', async () => {
    const root = await repo({ 'sub/file.txt': 'old\n', 'outside.txt': 'old\n' })
    put(root, 'sub/file.txt', 'changed\n')
    put(root, 'sub/new.txt', 'new\n')
    put(root, 'outside.txt', 'outside\n')
    const state = await status(join(root, 'sub'))
    expect(state.error).toBeUndefined()
    expect(state.files.map((file) => file.path)).toEqual(['file.txt', 'new.txt'])
    expect(await fileDiff(join(root, 'sub'), 'file.txt')).toContain('+changed')
  })
})

describe('snapshots and safe undo', () => {
  it('restores text, binary, added/deleted/renamed files, symlinks and modes while preserving the index', async () => {
    const root = await repo({ 'text.txt': 'original\n', 'removed.bin': Buffer.from([0, 1, 2]), 'binary.bin': Buffer.from([0, 3, 4]), 'old.txt': 'rename\n', 'script.sh': 'echo hi\n' })
    symlinkSync('text.txt', join(root, 'link'))
    await commit(root)
    put(root, 'text.txt', 'staged before turn\n')
    await command(root, 'add', 'text.txt')
    put(root, 'text.txt', 'working before turn\n')
    const beforeIndex = indexBytes(root)
    const before = await tree(root)
    expect(indexBytes(root)).toEqual(beforeIndex)
    put(root, 'text.txt', 'agent content\n')
    put(root, 'binary.bin', Buffer.from([0, 8, 9]))
    rmSync(join(root, 'removed.bin'))
    renameSync(join(root, 'old.txt'), join(root, 'new.txt'))
    put(root, 'new\t雪.bin', Buffer.from([0, 5, 6]))
    chmodSync(join(root, 'script.sh'), 0o755)
    rmSync(join(root, 'link'))
    symlinkSync('script.sh', join(root, 'link'))
    const after = await tree(root)
    expect(await diffTrees(root, before, after)).toContain('GIT binary patch')
    expect(await restoreTree(root, before, after)).toContain('Put back')
    expect(readFileSync(join(root, 'text.txt'), 'utf8')).toBe('working before turn\n')
    expect(readFileSync(join(root, 'removed.bin'))).toEqual(Buffer.from([0, 1, 2]))
    expect(readFileSync(join(root, 'binary.bin'))).toEqual(Buffer.from([0, 3, 4]))
    expect(readFileSync(join(root, 'old.txt'), 'utf8')).toBe('rename\n')
    expect(() => lstatSync(join(root, 'new.txt'))).toThrow()
    expect(() => lstatSync(join(root, 'new\t雪.bin'))).toThrow()
    expect(lstatSync(join(root, 'script.sh')).mode & 0o111).toBe(0)
    expect(readlinkSync(join(root, 'link'))).toBe('text.txt')
    expect(indexBytes(root)).toEqual(beforeIndex)
  })

  it('refuses all changes if another agent edited even a distant part of an affected file', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}\n`)
    const root = await repo({ 'first.txt': 'before\n', 'later.txt': lines.join('') })
    const before = await tree(root)
    put(root, 'first.txt', 'agent\n')
    lines[1] = 'agent line\n'
    put(root, 'later.txt', lines.join(''))
    const after = await tree(root)
    lines[35] = 'another agent\n'
    put(root, 'later.txt', lines.join(''))
    const savedIndex = indexBytes(root)
    await expect(restoreTree(root, before, after)).rejects.toThrow('changed again')
    expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('agent\n')
    expect(readFileSync(join(root, 'later.txt'), 'utf8')).toBe(lines.join(''))
    expect(indexBytes(root)).toEqual(savedIndex)
  })

  it('protects a removed file recreated later, even when it is now ignored', async () => {
    const root = await repo({ 'removed.txt': 'original\n', 'other.txt': 'before\n' })
    const before = await tree(root)
    await command(root, 'rm', 'removed.txt')
    put(root, 'other.txt', 'agent\n')
    const after = await tree(root)
    put(root, '.gitignore', 'removed.txt\n')
    put(root, 'removed.txt', 'later user file\n')
    await expect(restoreTree(root, before, after)).rejects.toThrow('changed again')
    expect(readFileSync(join(root, 'removed.txt'), 'utf8')).toBe('later user file\n')
    expect(readFileSync(join(root, 'other.txt'), 'utf8')).toBe('agent\n')
  })

  it('includes ignored tracked files and skips internal room files without touching staging', async () => {
    const root = await repo({ 'tracked.log': 'before\n', '.collab/tasks.md': 'original tasks\n' })
    put(root, '.gitignore', '*.log\n')
    const before = await tree(root)
    put(root, 'tracked.log', 'agent\n')
    put(root, 'ignored.log', 'ignored\n')
    put(root, '.collab/tasks.md', 'new tasks\n')
    const after = await tree(root)
    const diff = await diffTrees(root, before, after)
    expect(diff).toContain('tracked.log')
    expect(diff).not.toContain('ignored.log')
    expect(diff).not.toContain('tasks.md')
    await restoreTree(root, before, after)
    expect(readFileSync(join(root, 'tracked.log'), 'utf8')).toBe('before\n')
    expect(readFileSync(join(root, '.collab/tasks.md'), 'utf8')).toBe('new tasks\n')
  })

  it('undoes changes beneath a selected subfolder and leaves unrelated later edits alone', async () => {
    const root = await repo({ 'sub/file.txt': 'before\n', 'outside.txt': 'before\n' })
    const folder = join(root, 'sub')
    const before = await tree(folder)
    put(root, 'sub/file.txt', 'agent\n')
    const after = await tree(folder)
    put(root, 'outside.txt', 'later\n')
    await restoreTree(folder, before, after)
    expect(readFileSync(join(folder, 'file.txt'), 'utf8')).toBe('before\n')
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('later\n')
  })

  it('restores file/directory replacements without overwriting later directory contents', async () => {
    const root = await repo({ 'becomes-dir': 'original file\n', 'becomes-file/child.txt': 'original child\n' })
    const before = await tree(root)
    rmSync(join(root, 'becomes-dir'))
    put(root, 'becomes-dir/child.txt', 'agent child\n')
    rmSync(join(root, 'becomes-file'), { recursive: true })
    put(root, 'becomes-file', 'agent file\n')
    const after = await tree(root)
    put(root, 'becomes-dir/later.txt', 'later edit\n')
    await expect(restoreTree(root, before, after)).rejects.toThrow('new files appeared')
    expect(readFileSync(join(root, 'becomes-file'), 'utf8')).toBe('agent file\n')
    rmSync(join(root, 'becomes-dir/later.txt'))
    await restoreTree(root, before, after)
    expect(readFileSync(join(root, 'becomes-dir'), 'utf8')).toBe('original file\n')
    expect(readFileSync(join(root, 'becomes-file/child.txt'), 'utf8')).toBe('original child\n')
  })
})

describe('agent worktrees', () => {
  it('reuses the shared branch base after the main branch advances', async () => {
    const root = await repo({ 'main.txt': 'original\n' })
    const worktree = join(root, 'agent-copy')
    const first = await addWorktree(root, worktree, 'agent/test')
    put(root, 'main.txt', 'main advances\n')
    await command(root, 'add', 'main.txt')
    await command(root, 'commit', '-m', 'Main advances')
    expect(await addWorktree(root, worktree, 'agent/test')).toEqual(first)
  })

  it('authors and commits agent and merge commits exclusively with the configured user identity', async () => {
    const root = await repo({ 'main.txt': 'original\n' })
    const worktree = join(root, 'agent-copy')
    await addWorktree(root, worktree, 'agent/test')
    put(worktree, 'agent.txt', 'agent change\n')
    put(worktree, '.collab/private.md', 'room metadata\n')
    const result = await mergeWorktree(root, worktree, 'agent/test', 'Assistant')
    expect(result).toContain('Merged')
    expect(readFileSync(join(root, 'agent.txt'), 'utf8')).toBe('agent change\n')
    const log = await command(root, 'log', '-2', '--format=%an <%ae>|%cn <%ce>%n%B')
    expect(log.match(/Masudali23 <alimasud2023@gmail.com>\|Masudali23 <alimasud2023@gmail.com>/g)).toHaveLength(2)
    expect(log).not.toContain('Co-authored-by')
    expect(log).not.toContain('interface@localhost')
    expect(await command(root, 'ls-files', '.collab')).toBe('')
  })
})
