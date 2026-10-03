import { realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FileLinkTarget, Room } from '@shared/types'

const CONTROL = /[\u0000-\u001f\u007f]/
const OUTSIDE = 'That file is outside this session’s project folders.'
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/
const EXTERNAL_SCHEME = /^(?:https?|data|javascript|vbscript|blob|mailto|tel|ftp|vscode|iface):/i

function contains(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Require both the requested path and its symlink destination to share a root. */
export function pathInsideRoots(path: string, roots: readonly string[]): boolean {
  if (typeof path !== 'string' || !path || CONTROL.test(path)) return false
  const full = resolve(path)
  try {
    const real = realpathSync(full)
    return roots.some((root) => {
      try { return contains(resolve(root), full) && contains(realpathSync(root), real) } catch { return false }
    })
  } catch { return false }
}

function checkedPath(path: string, roots: readonly string[]): string {
  if (CONTROL.test(path)) throw new Error('The file link contains invalid characters.')
  const full = resolve(path)
  if (!roots.some((root) => contains(resolve(root), full))) throw new Error(OUTSIDE)
  try {
    // Report missing files separately from a boundary violation.
    realpathSync(full)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new Error('That file no longer exists. Refresh the link or check its path.')
    }
    throw new Error('That file could not be accessed.')
  }
  if (!pathInsideRoots(full, roots)) throw new Error(OUTSIDE)
  return full
}

function decode(value: string): string {
  try {
    const decoded = decodeURIComponent(value)
    if (CONTROL.test(decoded)) throw new Error()
    return decoded
  } catch { throw new Error('The file link contains invalid characters or URL encoding.') }
}

function position(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('The file link has an invalid line or column number.')
  return number
}

function metadata(fragment?: string): Pick<FileLinkTarget, 'line' | 'column' | 'fragment'> {
  if (!fragment) return {}
  const target = /^L(\d+)(?:C(\d+)|-L?(\d+))?$/i.exec(fragment)
  if (!target) return { fragment }
  if (target[3]) position(target[3])
  return { line: position(target[1]), ...(target[2] ? { column: position(target[2]) } : {}), fragment }
}

function exists(path: string): boolean {
  try { statSync(path); return true } catch { return false }
}

/** Resolve a chat or nested-document link without granting access to other rooms. */
export function resolveFileLink(
  room: Pick<Room, 'folder' | 'members'>,
  href: string,
  memberId?: string,
  fromFile?: string
): FileLinkTarget {
  if (typeof href !== 'string' || !href.trim() || CONTROL.test(href)) throw new Error('The file link is empty or invalid.')
  const roots = [room.folder, ...room.members.flatMap((member) => member.worktree ? [member.worktree.path] : [])]
  let cwd = room.members.find((member) => member.id === memberId)?.worktree?.path ?? room.folder
  if (fromFile !== undefined) {
    if (typeof fromFile !== 'string' || !isAbsolute(fromFile)) throw new Error('The preview’s base file is invalid.')
    fromFile = checkedPath(fromFile, roots)
    if (!statSync(fromFile).isFile()) throw new Error('The preview’s base path must be a file.')
    cwd = dirname(fromFile)
  }

  let path: string
  let fragment: string | undefined
  let literal: boolean
  if (/^file:/i.test(href)) {
    // fileURLToPath decodes exactly once. Encoded # and % belong to the filename.
    let url: URL
    try { url = new URL(href) } catch { throw new Error('The file URL is invalid.') }
    if (!/^file:\/\//i.test(href) || (url.hostname && url.hostname !== 'localhost') || url.username || url.password || url.port || url.search) {
      throw new Error('Only local file URLs without query parameters can be opened.')
    }
    fragment = url.hash ? decode(url.hash.slice(1)) : undefined
    try { path = fileURLToPath(url) } catch { throw new Error('The file URL is invalid.') }
    literal = exists(path)
  } else {
    if (/^[\\/]{2}/.test(href) || EXTERNAL_SCHEME.test(href)) throw new Error('That link is not a supported local file link.')
    // An existing literal filename wins over ambiguous URL/line punctuation.
    const raw = resolve(cwd, href)
    literal = exists(raw)
    if (literal) path = href
    else {
      const hash = href.indexOf('#')
      path = hash < 0 ? href : href.slice(0, hash)
      fragment = hash < 0 ? undefined : decode(href.slice(hash + 1))
      if (!path && fromFile) path = fromFile
      if (!path) throw new Error('A document is needed to open this section link.')
      // fromFile and literal % filenames are filesystem paths, not encoded URLs.
      literal = exists(resolve(cwd, path))
      if (!literal) {
        path = decode(path)
        literal = exists(resolve(cwd, path))
      }
    }
    // A :line suffix is valid on bare filenames too (README:12).
    const withoutPosition = path.replace(LINE_SUFFIX, '')
    if (/^[a-z][a-z\d+.-]*:/i.test(withoutPosition)) throw new Error('That link uses an unsupported URL scheme.')
  }
  if (CONTROL.test(path)) throw new Error('The file link contains invalid characters.')
  let target = metadata(fragment)
  if (!literal) {
    const suffix = LINE_SUFFIX.exec(path)
    if (suffix) {
      path = path.slice(0, suffix.index)
      target = { line: position(suffix[1]), ...(suffix[2] ? { column: position(suffix[2]) } : {}), ...target }
    }
  }
  const full = checkedPath(resolve(cwd, path), roots)
  const info = statSync(full)
  if (!info.isFile() && !info.isDirectory()) throw new Error('That link does not point to a regular file or folder.')
  return { path: full, isDirectory: info.isDirectory(), ...target }
}

const PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
}

function byteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return undefined
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return undefined
  const start = first ?? Math.max(0, size - last!)
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1)
  if (start >= size || start > end) return undefined
  return { start, end }
}

/** Stream previews through Chromium's file loader; never embed local HTML/scripts. */
export async function filePreviewResponse(
  request: Request,
  path: string,
  roots: readonly string[],
  fetchFile: (url: string, init: RequestInit) => Promise<Response>
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
  if (!pathInsideRoots(path, roots)) return new Response('File not found or outside the open folders', { status: 403 })
  const mime = PREVIEW_MIME[extname(path).toLowerCase()]
  if (!mime) return new Response('This file type is not served as an embedded preview', { status: 415 })
  try {
    const real = realpathSync(path)
    const info = statSync(real)
    if (!info.isFile()) return new Response('Not a regular file', { status: 404 })
    const modified = info.mtime.toUTCString()
    const requestHeaders = new Headers()
    // Chromium's PDF viewer seeks within larger PDFs with byte-range requests.
    const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null
    const ifRange = request.headers.get('if-range')
    let range: ReturnType<typeof byteRange>
    if (rangeHeader && (!ifRange || ifRange === modified)) {
      range = byteRange(rangeHeader, info.size)
      if (!range) return new Response('Requested range is not available', { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
      requestHeaders.set('range', `bytes=${range.start}-${range.end}`)
    }
    const response = await fetchFile(pathToFileURL(real).href, { method: request.method, headers: requestHeaders, signal: request.signal })
    const headers = new Headers(response.headers)
    headers.set('Content-Type', mime)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Content-Length', String(range ? range.end - range.start + 1 : info.size))
    headers.set('Last-Modified', modified)
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Cache-Control', 'no-store')
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    // Electron's file loader honors Range but omits the HTTP 206/range headers.
    return new Response(response.body, { status: range ? 206 : response.status, headers })
  } catch { return new Response('That file could not be loaded', { status: 404 }) }
}
