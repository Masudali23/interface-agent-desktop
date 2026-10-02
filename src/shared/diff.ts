export interface DiffLine {
  kind: 'context' | 'add' | 'remove' | 'note'
  text: string
  oldLine?: number
  newLine?: number
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface DiffFile {
  path: string
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  binary: boolean
  added: number
  removed: number
  metadata: string[]
  hunks: DiffHunk[]
}

/** Git quotes unusual filenames using C escapes, including UTF-8 octal bytes. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  const bytes: number[] = []
  const text = value.slice(1, value.endsWith('"') ? -1 : undefined)
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length + 1; continue }
      if (text[i + 1] in escapes) { bytes.push(escapes[text[i + 1]]); i += 2; continue }
    }
    const character = String.fromCodePoint(text.codePointAt(i)!)
    bytes.push(...new TextEncoder().encode(character))
    i += character.length
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function headerPath(value: string, gitPrefix = false): string {
  const path = decodeGitPath(value.split('\t')[0])
  return gitPrefix ? path.replace(/^[ab]\//, '') : path
}

function gitHeaderPaths(line: string): [string, string] | undefined {
  const body = line.slice('diff --git '.length)
  // Spaces are not quoted by Git. For unchanged names, choose the boundary that
  // produces the same path on both sides, even if the filename contains " b/".
  if (body.startsWith('a/')) {
    for (let split = body.indexOf(' b/'); split !== -1; split = body.indexOf(' b/', split + 1)) {
      const before = headerPath(body.slice(0, split), true)
      const after = headerPath(body.slice(split + 1), true)
      if (before === after) return [before, after]
    }
  }
  const match = /^("(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(body)
  return match ? [headerPath(match[1], true), headerPath(match[2], true)] : undefined
}

/** Parses patches into files and numbered lines; +++ inside a hunk is added code. */
export function parseUnifiedDiff(patch: string, fallbackPath = 'Changes'): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldLine: number | undefined
  let newLine: number | undefined
  let oldRemaining = 0
  let newRemaining = 0
  let gitPaths = false
  let literalPaths = false
  let oldHeader: string | undefined
  const makeFile = (path: string): DiffFile => ({ path, status: 'modified', binary: false, added: 0, removed: 0, metadata: [], hunks: [] })
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = gitHeaderPaths(line)
      file = makeFile(paths?.[1] ?? fallbackPath)
      if (paths) file.oldPath = paths[0]
      files.push(file)
      hunk = undefined
      gitPaths = true
      literalPaths = false
      oldHeader = undefined
      continue
    }
    if (!file) { file = makeFile(fallbackPath); files.push(file) }
    if (hunk && oldRemaining === 0 && newRemaining === 0 && !line.startsWith('\\')) hunk = undefined
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (range) {
      oldLine = Number(range[1]); newLine = Number(range[3])
      oldRemaining = Number(range[2] ?? 1); newRemaining = Number(range[4] ?? 1)
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (hunk && /^[ +\\-]/.test(line)) {
      if (line.startsWith('+')) { hunk.lines.push({ kind: 'add', text: line.slice(1), newLine }); if (newLine !== undefined) newLine++; file.added++; newRemaining-- }
      else if (line.startsWith('-')) { hunk.lines.push({ kind: 'remove', text: line.slice(1), oldLine }); if (oldLine !== undefined) oldLine++; file.removed++; oldRemaining-- }
      else if (line.startsWith(' ')) { hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine }); if (oldLine !== undefined) oldLine++; if (newLine !== undefined) newLine++; oldRemaining--; newRemaining-- }
      else hunk.lines.push({ kind: 'note', text: line })
      continue
    }
    if (line.startsWith('--- ')) {
      if (file.hunks.length) {
        file = makeFile(fallbackPath)
        files.push(file)
        gitPaths = false
      }
      oldHeader = headerPath(line.slice(4))
      const path = gitPaths ? oldHeader.replace(/^[ab]\//, '') : oldHeader
      if (path === '/dev/null') file.status = 'added'
      else file.oldPath = path
    } else if (line.startsWith('+++ ')) {
      const newHeader = headerPath(line.slice(4))
      const prefixed = gitPaths || (!literalPaths && (oldHeader?.startsWith('a/') || oldHeader === '/dev/null') && (newHeader.startsWith('b/') || newHeader === '/dev/null'))
      const path = prefixed ? newHeader.replace(/^[ab]\//, '') : newHeader
      if (oldHeader && oldHeader !== '/dev/null') file.oldPath = prefixed ? oldHeader.replace(/^[ab]\//, '') : oldHeader
      if (path === '/dev/null') { file.status = 'deleted'; file.path = file.oldPath ?? fallbackPath }
      else file.path = path
    } else if (line.startsWith('rename from ')) { file.oldPath = decodeGitPath(line.slice(12)); file.status = 'renamed' }
    else if (line.startsWith('rename to ')) { file.path = decodeGitPath(line.slice(10)); file.status = 'renamed' }
    else if (line.startsWith('new file mode ')) file.status = 'added'
    else if (line.startsWith('deleted file mode ')) file.status = 'deleted'
    else if (line) {
      // jsdiff's file separator precedes literal filenames, including a/ or b/.
      if (/^={3,}$/.test(line)) literalPaths = true
      if (/^(Binary files |GIT binary patch)/.test(line)) file.binary = true
      file.metadata.push(line)
    }
  }
  return files.filter((f) => f.hunks.length || f.metadata.length || f.status !== 'modified')
}

export interface SplitDiffLine { left?: DiffLine; right?: DiffLine }
export function splitDiffLines(lines: DiffLine[]): SplitDiffLine[] {
  const out: SplitDiffLine[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === 'context' || line.kind === 'note') { out.push({ left: line, right: line }); i++; continue }
    const removed: DiffLine[] = [], added: DiffLine[] = []
    while (i < lines.length && lines[i].kind === 'remove') removed.push(lines[i++])
    while (i < lines.length && lines[i].kind === 'add') added.push(lines[i++])
    for (let n = 0; n < Math.max(removed.length, added.length); n++) out.push({ left: removed[n], right: added[n] })
  }
  return out
}
