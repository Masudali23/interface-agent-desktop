// Git helpers: live changes, isolated worktrees and safe per-turn undo.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, lstatSync, readFileSync, readlinkSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitFile, GitState } from '@shared/types'

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[], input?: string, extraEnv: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((done) => {
    const child = execFile('git', args, {
      cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extraEnv }
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || '') })
    })
    // Always close stdin, including when Git fails before reading a supplied patch.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

function errorText(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback
}

async function checked(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  const result = await git(cwd, args, input, env)
  if (result.code !== 0) throw new Error(errorText(result, `git ${args[0]} failed`))
  return result.stdout
}

const outputLine = (value: string): string => value.replace(/\r?\n$/, '')
const internalPath = (path: string): boolean => path === '.collab' || path.startsWith('.collab/')
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color']
const STATUS: Record<string, string> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' }

/** Literal, relative paths only; never traverse a parent symlink outside the folder. */
function safePath(cwd: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('Expected a file path inside the project folder')
  const root = resolve(cwd)
  const absolute = resolve(root, path)
  const local = relative(root, absolute)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || local.split(sep).includes('.git')) {
    throw new Error('File path must stay inside the project folder')
  }
  const realRoot = realpathSync(root)
  let parent = dirname(absolute)
  while (!existsSync(parent)) parent = dirname(parent)
  const realParent = realpathSync(parent)
  const parentLocal = relative(realRoot, realParent)
  if (parentLocal === '..' || parentLocal.startsWith(`..${sep}`) || isAbsolute(parentLocal)) {
    throw new Error('File path follows a directory outside the project folder')
  }
  return local.split(sep).join('/')
}

async function objectId(cwd: string, ref: string, kind: 'tree' | 'commit' = 'tree'): Promise<string> {
  if (!ref || ref.startsWith('-') || ref.includes('\0')) throw new Error('Invalid Git revision')
  return (await checked(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{${kind}}`])).trim()
}

async function comparisonTree(cwd: string, base?: string): Promise<string> {
  if (base !== undefined) return objectId(cwd, base)
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])
  if (head.code === 0) return head.stdout.trim()
  const symbolic = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
  if (symbolic.code !== 0) throw new Error(errorText(head, 'Could not read HEAD'))
  const branch = await git(cwd, ['show-ref', '--verify', '--quiet', symbolic.stdout.trim()])
  if (branch.code !== 1) throw new Error(errorText(head, 'Could not read HEAD'))
  // Computing this via Git also supports repositories using SHA-256 object IDs.
  return (await checked(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '')).trim()
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

function porcelainFiles(raw: string, prefix: string): Map<string, GitFile> {
  const files = new Map<string, GitFile>()
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const repoPath = entry.slice(3)
    const old = /[RC]/.test(code) ? parts[++i] : undefined
    if (!repoPath.startsWith(prefix)) continue
    const path = repoPath.slice(prefix.length)
    if (internalPath(path)) continue
    const conflict = code.includes('U') || code === 'AA' || code === 'DD'
    const letter = code[1] === 'D' ? 'D' : code.trim()[0] || 'M'
    files.set(path, {
      path, status: conflict ? 'conflict' : STATUS[letter] ?? 'modified',
      staged: code[0] !== ' ' && code[0] !== '?',
      ...(old?.startsWith(prefix) ? { oldPath: old.slice(prefix.length) } : {})
    })
  }
  return files
}

function addNames(files: Map<string, GitFile>, raw: string): void {
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length && parts[i];) {
    const code = parts[i++]
    const firstPath = parts[i++]
    const renamed = code[0] === 'R' || code[0] === 'C'
    const path = renamed ? parts[i++] : firstPath
    if (!path || internalPath(path)) continue
    const file = files.get(path) ?? { path, status: STATUS[code[0]] ?? 'modified', staged: false }
    if (renamed) {
      file.oldPath = firstPath
      if (file.status !== 'conflict') file.status = STATUS[code[0]]
    }
    files.set(path, file)
  }
}

function addNumstat(files: Map<string, GitFile>, raw: string): void {
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    // Only the first two tabs delimit fields: tabs and newlines are legal in names.
    const first = entry.indexOf('\t')
    const second = entry.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = entry.slice(0, first)
    const removed = entry.slice(first + 1, second)
    let path = entry.slice(second + 1)
    let oldPath: string | undefined
    if (!path) {
      oldPath = parts[++i]
      path = parts[++i]
    }
    if (!path || internalPath(path)) continue
    const file = files.get(path) ?? { path, status: oldPath ? 'renamed' : 'modified', staged: false }
    file.binary = added === '-' || removed === '-'
    file.added = file.binary ? undefined : Number(added)
    file.removed = file.binary ? undefined : Number(removed)
    if (oldPath) file.oldPath = oldPath
    files.set(path, file)
  }
}

function untrackedStats(cwd: string, file: GitFile, budget: { remaining: number }): void {
  try {
    const absolute = join(cwd, safePath(cwd, file.path))
    const info = lstatSync(absolute)
    let data: Buffer
    let complete = true
    if (info.isSymbolicLink()) data = Buffer.from(readlinkSync(absolute))
    else if (info.isFile()) {
      const limit = Math.min(1024 * 1024, budget.remaining)
      complete = info.size <= limit
      if (complete) data = readFileSync(absolute)
      else {
        data = Buffer.alloc(Math.min(8000, info.size))
        const fd = openSync(absolute, 'r')
        try { data = data.subarray(0, readSync(fd, data, 0, data.length, 0)) } finally { closeSync(fd) }
      }
      budget.remaining = Math.max(0, budget.remaining - data.length)
    } else return
    file.binary = data.subarray(0, 8000).includes(0)
    if (!file.binary && complete) {
      file.added = data.reduce((lines, byte) => lines + (byte === 10 ? 1 : 0), 0) + (data.length && data[data.length - 1] !== 10 ? 1 : 0)
      file.removed = 0
    }
  } catch {
    // A live refresh may race a file being removed or renamed. Keep the status row.
  }
}

/** Working tree and index changes, plus committed changes against an optional base. */
export async function status(cwd: string, base?: string): Promise<GitState> {
  if (!existsSync(cwd)) return { isRepo: false, files: [], error: 'Folder not found' }
  const repo = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (repo.code !== 0 || repo.stdout.trim() !== 'true') {
    return { isRepo: false, files: [], ...(!repo.stderr.includes('not a git repository') && repo.code !== 0 ? { error: errorText(repo, 'Could not read repository') } : {}) }
  }
  let branch: string | undefined
  try {
    const [symbolic, prefix, tree] = await Promise.all([
      git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      checked(cwd, ['rev-parse', '--show-prefix']), comparisonTree(cwd, base)
    ])
    branch = symbolic.code === 0 ? outputLine(symbolic.stdout) : (await checked(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    const [porcelain, names, numbers] = await Promise.all([
      checked(cwd, ['status', '--porcelain=v1', '-uall', '-z', '--', '.']),
      checked(cwd, ['diff', ...DIFF_OPTIONS, '--name-status', '-z', '--find-renames', '--relative', tree, '--', '.']),
      checked(cwd, ['diff', ...DIFF_OPTIONS, '--numstat', '-z', '--find-renames', '--relative', tree, '--', '.'])
    ])
    const files = porcelainFiles(porcelain, outputLine(prefix))
    addNames(files, names)
    addNumstat(files, numbers)
    const budget = { remaining: 8 * 1024 * 1024 }
    for (const file of files.values()) if (file.status === 'untracked') untrackedStats(cwd, file, budget)
    return { isRepo: true, branch, files: [...files.values()].sort((x, y) => x.path.localeCompare(y.path)) }
  } catch (error) {
    return { isRepo: true, branch, files: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Unified diff of a literal path, including both sides of a rename. */
export async function fileDiff(cwd: string, path: string, base?: string, oldPath?: string): Promise<string> {
  path = safePath(cwd, path)
  if (oldPath !== undefined) oldPath = safePath(cwd, oldPath)
  const tree = await comparisonTree(cwd, base)
  if (!oldPath) {
    const state = await status(cwd, base)
    if (state.error) throw new Error(state.error)
    oldPath = state.files.find((file) => file.path === path)?.oldPath
    if (oldPath) oldPath = safePath(cwd, oldPath)
  }
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
  const diff = await checked(cwd, ['--literal-pathspecs', 'diff', ...DIFF_OPTIONS, '--find-renames', '--relative', tree, '--', ...paths])
  if (diff) return diff
  const tracked = await git(cwd, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '-z', '--', path])
  if (tracked.code === 0) return ''
  if (tracked.code !== 1) throw new Error(errorText(tracked, 'Could not check the file'))
  let info: ReturnType<typeof lstatSync>
  try { info = lstatSync(join(cwd, path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  if (info.isDirectory()) throw new Error('Choose a file to view its diff')
  const result = await git(cwd, ['diff', ...DIFF_OPTIONS, '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', path])
  if (result.code > 1) throw new Error(errorText(result, 'Could not read the file diff'))
  return result.stdout
}

async function validateBranch(cwd: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith('-') || branch.includes('\0')) throw new Error('Invalid branch name')
  const valid = await checked(cwd, ['check-ref-format', '--branch', branch])
  if (outputLine(valid) !== branch) throw new Error('Use an explicit branch name')
}

/** Creates an agent worktree, retaining the common base when reusing its branch. */
export async function addWorktree(repo: string, path: string, branch: string): Promise<{ base: string }> {
  await validateBranch(repo, branch)
  const head = await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0) throw new Error('This folder has no commits yet. Make a first commit so each agent can get its own copy.')
  let base = head.stdout.trim()
  if (existsSync(join(path, '.git'))) {
    const [repoCommon, worktreeCommon, worktreeBranch] = await Promise.all([
      checked(repo, ['rev-parse', '--git-common-dir']), checked(path, ['rev-parse', '--git-common-dir']),
      checked(path, ['symbolic-ref', '--quiet', 'HEAD'])
    ])
    if (realpathSync(resolve(repo, outputLine(repoCommon))) !== realpathSync(resolve(path, outputLine(worktreeCommon))) || worktreeBranch.trim() !== `refs/heads/${branch}`) {
      throw new Error('The existing worktree belongs to another repository or branch')
    }
    base = (await checked(repo, ['merge-base', base, `refs/heads/${branch}`])).trim()
    return { base }
  }
  mkdirSync(dirname(path), { recursive: true })
  const branchExists = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (branchExists.code > 1) throw new Error(errorText(branchExists, 'Could not check the agent branch'))
  if (branchExists.code === 0) base = (await checked(repo, ['merge-base', base, `refs/heads/${branch}`])).trim()
  await checked(repo, branchExists.code === 0 ? ['worktree', 'add', '--', path, branch] : ['worktree', 'add', '-b', branch, '--', path, base])
  return { base }
}

async function configuredIdentity(cwd: string): Promise<Record<string, string>> {
  const [name, email] = await Promise.all([git(cwd, ['config', '--get', 'user.name']), git(cwd, ['config', '--get', 'user.email'])])
  if (name.code !== 0 || email.code !== 0 || !name.stdout.trim() || !email.stdout.trim()) {
    throw new Error('Set your Git user.name and user.email before committing or merging agent changes')
  }
  return { GIT_AUTHOR_NAME: outputLine(name.stdout), GIT_AUTHOR_EMAIL: outputLine(email.stdout), GIT_COMMITTER_NAME: outputLine(name.stdout), GIT_COMMITTER_EMAIL: outputLine(email.stdout) }
}

/** Commits and merges with the user's configured Git identity. */
export async function mergeWorktree(repo: string, worktree: string, branch: string, label: string): Promise<string> {
  await validateBranch(repo, branch)
  const [author, merger, dirty] = await Promise.all([
    configuredIdentity(worktree), configuredIdentity(repo),
    checked(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.', ':(exclude).collab'])
  ])
  if (dirty) throw new Error('The main folder has uncommitted changes. Commit or stash them first, then merge.')
  const currentBranch = (await checked(worktree, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
  if (currentBranch !== `refs/heads/${branch}`) throw new Error('The agent worktree is on a different branch')
  await checked(worktree, ['add', '-A', '--', '.', ':(exclude).collab'])
  const staged = await git(worktree, ['diff', '--cached', '--quiet'])
  if (staged.code > 1) throw new Error(errorText(staged, 'Could not read staged changes'))
  if (staged.code === 1) {
    await checked(worktree, ['commit', '-m', `${label.replace(/[\r\n]+/g, ' ')}: changes from Interface`], undefined, author)
  }
  const merge = await git(repo, ['merge', '--no-ff', '--no-edit', '--', `refs/heads/${branch}`], undefined, merger)
  if (merge.code !== 0) {
    const pending = await git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
    if (pending.code === 0) {
      const abort = await git(repo, ['merge', '--abort'])
      if (abort.code !== 0) throw new Error(`Merge failed: ${errorText(merge, 'unknown error')}. Could not abort: ${errorText(abort, 'inspect the repository before continuing')}`)
    }
    throw new Error(`Merge failed: ${errorText(merge, 'Could not merge the agent branch')}`)
  }
  return `Merged ${label}'s branch ${branch} into ${(await checked(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()}`
}

export async function resetWorktree(worktree: string, base: string): Promise<string> {
  const commit = await objectId(worktree, base, 'commit')
  await checked(worktree, ['reset', '--hard', commit])
  await checked(worktree, ['clean', '-fd'])
  return 'Discarded the agent changes'
}

export async function removeWorktree(repo: string, worktree: string, branch: string): Promise<void> {
  await validateBranch(repo, branch)
  await checked(repo, ['worktree', 'remove', '--force', '--', worktree])
  await checked(repo, ['branch', '-D', '--', branch])
}

/** Reverses a patch without changing the user's index. Git preflights the whole patch. */
export async function reverseApply(cwd: string, diff: string): Promise<string> {
  const patch = diff.endsWith('\n') ? diff : `${diff}\n`
  const check = await git(cwd, ['apply', '-R', '--check', '--whitespace=nowarn'], patch)
  if (check.code !== 0) throw new Error(`These files changed again since that turn, so they can't be put back automatically. ${errorText(check, 'Patch no longer applies')}`)
  await checked(cwd, ['apply', '-R', '--whitespace=nowarn'], patch)
  const count = (diff.match(/^diff --git /gm) ?? []).length || (diff.match(/^\+\+\+ /gm) ?? []).length
  return `Put back ${count || 'the'} file${count === 1 ? '' : 's'}`
}

export async function listFiles(cwd: string): Promise<string[]> {
  if (!(await isRepo(cwd))) return []
  const result = await checked(cwd, ['ls-files', '-co', '--exclude-standard', '-z'])
  return [...new Set(result.split('\0').filter((file) => file && !internalPath(file)))].slice(0, 20000)
}

const tempIndex = (): string => join(tmpdir(), `iface-index-${randomBytes(12).toString('hex')}`)
function removeIndex(index: string): void {
  rmSync(index, { force: true })
  rmSync(`${index}.lock`, { force: true })
}

/** Captures tracked and untracked files without changing the real index or branches. */
export async function snapshot(cwd: string): Promise<string | undefined> {
  if (!(await isRepo(cwd))) return undefined
  const index = tempIndex()
  try {
    const env = { GIT_INDEX_FILE: index }
    const root = outputLine(await checked(cwd, ['rev-parse', '--show-toplevel']))
    // Seed with tracked entries, including ignored tracked files and conflicted stages.
    const entries = await checked(root, ['ls-files', '--stage', '-z'])
    await checked(root, ['read-tree', '--empty'], undefined, env)
    await checked(root, ['update-index', '-z', '--index-info'], entries, env)
    await checked(cwd, ['add', '-A', '--', '.', ':(exclude).collab'], undefined, env)
    await checked(cwd, ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.collab'], undefined, env)
    return (await checked(cwd, ['write-tree'], undefined, env)).trim()
  } catch {
    return undefined
  } finally {
    removeIndex(index)
  }
}

export async function diffTrees(cwd: string, from: string, to: string): Promise<string> {
  const [before, after] = await Promise.all([objectId(cwd, from), objectId(cwd, to)])
  return checked(cwd, ['diff', ...DIFF_OPTIONS, '--binary', '--full-index', '--no-renames', before, after, '--', '.'])
}

/** Validates every affected file against the turn's final state before undoing anything. */
export async function restoreTree(cwd: string, from: string, to: string): Promise<string> {
  const [before, after] = await Promise.all([objectId(cwd, from), objectId(cwd, to)])
  const root = outputLine(await checked(cwd, ['rev-parse', '--show-toplevel']))
  const prefix = outputLine(await checked(cwd, ['rev-parse', '--show-prefix']))
  const raw = await checked(cwd, ['diff', ...DIFF_OPTIONS, '--name-only', '--no-renames', '-z', before, after, '--', '.'])
  const paths = raw.split('\0').filter(Boolean)
  if (!paths.length) return 'Nothing to put back'
  for (const path of paths) {
    if (!path.startsWith(prefix)) throw new Error('Undo includes a file outside the project folder')
    safePath(cwd, path.slice(prefix.length))
  }
  const index = tempIndex()
  try {
    const env = { GIT_INDEX_FILE: index }
    await checked(root, ['read-tree', after], undefined, env)
    const entries = await checked(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', after, '--', ...paths])
    const expected = new Set<string>()
    for (const entry of entries.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t')
      if (entry.startsWith('160000 ')) throw new Error('Undo of a submodule requires restoring that repository separately')
      expected.add(entry.slice(tab + 1))
    }
    // A removed file must still be absent. A file replaced by a directory is valid
    // only while that directory contains exactly the turn's expected contents.
    for (const path of paths) {
      if (expected.has(path)) continue
      try {
        const info = lstatSync(join(root, path))
        if (info.isDirectory() && [...expected].some((entry) => entry.startsWith(`${path}/`))) continue
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
        throw error
      }
      throw new Error(`Cannot undo: ${path} changed again since that turn. No files were changed.`)
    }
    const extra = await checked(root, ['--literal-pathspecs', 'ls-files', '--others', '--directory', '-z', '--', ...paths], undefined, env)
    if (extra) throw new Error('Cannot undo: new files appeared in an affected path. No files were changed.')
    const current = await git(root, ['--literal-pathspecs', 'diff', ...DIFF_OPTIONS, '--quiet', '--no-renames', after, '--', ...paths], undefined, env)
    if (current.code !== 0) {
      if (current.code > 1) throw new Error(errorText(current, 'Could not verify current files'))
      throw new Error('Cannot undo: files changed again since that turn. No files were changed.')
    }
    const patch = await checked(root, ['--literal-pathspecs', 'diff', ...DIFF_OPTIONS, '--binary', '--full-index', '--no-renames', before, after, '--', ...paths])
    await reverseApply(root, patch)
    return `Put back ${paths.length} file${paths.length === 1 ? '' : 's'}`
  } finally {
    removeIndex(index)
  }
}
