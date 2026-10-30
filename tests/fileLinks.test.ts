import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filePreviewResponse, pathInsideRoots, resolveFileLink } from '../src/main/fileLinks'
import type { Member, Room } from '../src/shared/types'

let directory: string
let project: string
let worktree: string
let outside: string
let room: Pick<Room, 'folder' | 'members'>

function put(path: string, text = 'Fixture text'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'interface-file-links-'))
  project = join(directory, 'project')
  worktree = join(directory, 'worktree')
  outside = join(directory, 'project-sibling')
  for (const path of [project, worktree, outside]) mkdirSync(path)
  room = { folder: project, members: [{ id: 'isolated', worktree: { path: worktree } } as Member] }
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('session file link resolution', () => {
  it('resolves absolute, relative, Unicode and encoded space paths', () => {
    const path = put(join(project, 'docs', 'বাংলা Hindi 日本語 (1).md'))
    expect(resolveFileLink(room, path)).toEqual({ path, isDirectory: false })
    expect(resolveFileLink(room, 'docs/বাংলা Hindi 日本語 (1).md').path).toBe(path)
    expect(resolveFileLink(room, 'docs/' + encodeURIComponent('বাংলা Hindi 日本語 (1).md')).path).toBe(path)
  })

  it('resolves line and column suffixes and code fragments', () => {
    const path = put(join(project, 'source.ts'))
    expect(resolveFileLink(room, 'source.ts:12')).toEqual({ path, isDirectory: false, line: 12 })
    expect(resolveFileLink(room, 'source.ts:12:3')).toEqual({ path, isDirectory: false, line: 12, column: 3 })
    expect(resolveFileLink(room, 'source.ts#L12-L20')).toEqual({ path, isDirectory: false, line: 12, fragment: 'L12-L20' })
    expect(resolveFileLink(room, 'source.ts#L12C3')).toEqual({ path, isDirectory: false, line: 12, column: 3, fragment: 'L12C3' })
    expect(resolveFileLink(room, 'source.ts:8#L12').line).toBe(12)
    put(join(project, 'README'))
    expect(resolveFileLink(room, 'README:12').line).toBe(12)
  })

  it('keeps Markdown headings and PDF page fragments', () => {
    const path = put(join(project, 'guide.md'))
    expect(resolveFileLink(room, 'guide.md#installation').fragment).toBe('installation')
    expect(resolveFileLink(room, '#বাংলা', undefined, path)).toEqual({ path, isDirectory: false, fragment: 'বাংলা' })
    put(join(project, 'document.pdf'))
    expect(resolveFileLink(room, 'document.pdf#page=2&zoom=125').fragment).toBe('page=2&zoom=125')
    expect(() => resolveFileLink(room, '#heading')).toThrow('document is needed')
  })

  it('prefers literal colon, hash and percent filenames', () => {
    const colon = put(join(project, 'source.ts:12'))
    const hash = put(join(project, 'notes#L12'))
    const percent = put(join(project, '100% ready.md'))
    put(join(project, 'source.ts'))
    put(join(project, 'notes'))
    expect(resolveFileLink(room, 'source.ts:12')).toEqual({ path: colon, isDirectory: false })
    expect(resolveFileLink(room, 'notes#L12')).toEqual({ path: hash, isDirectory: false })
    expect(resolveFileLink(room, '100% ready.md').path).toBe(percent)
    expect(resolveFileLink(room, '100% ready.md#intro')).toEqual({ path: percent, isDirectory: false, fragment: 'intro' })
    expect(resolveFileLink(room, pathToFileURL(hash).href).path).toBe(hash)
  })

  it('decodes file URLs exactly once and treats encoded hashes as filename characters', () => {
    const path = put(join(project, 'spaces %20 #L12.md'))
    const url = pathToFileURL(path)
    expect(resolveFileLink(room, url.href).path).toBe(path)
    url.hash = 'heading'
    expect(resolveFileLink(room, url.href)).toEqual({ path, isDirectory: false, fragment: 'heading' })
    expect(resolveFileLink(room, url.href.replace('file:///', 'file://localhost/')).path).toBe(path)
  })

  it('accepts a line suffix on file URLs', () => {
    const path = put(join(project, 'source.ts'))
    expect(resolveFileLink(room, pathToFileURL(path).href + ':42:7')).toEqual({ path, isDirectory: false, line: 42, column: 7 })
  })

  it('uses the author worktree and falls back to the project for an unknown member', () => {
    const main = put(join(project, 'README.md'), 'Main')
    const isolated = put(join(worktree, 'README.md'), 'Worktree')
    expect(resolveFileLink(room, 'README.md', 'isolated').path).toBe(isolated)
    expect(resolveFileLink(room, 'README.md', 'unknown').path).toBe(main)
    expect(resolveFileLink(room, isolated).path).toBe(isolated)
  })

  it('resolves nested preview links against their validated document', () => {
    const from = put(join(worktree, 'docs', 'guide.md'))
    const target = put(join(worktree, 'images', 'diagram.png'))
    expect(resolveFileLink(room, '../images/diagram.png', undefined, from).path).toBe(target)
    expect(resolveFileLink(room, '#intro', undefined, from).path).toBe(from)
    const outsideBase = put(join(outside, 'base.md'))
    expect(() => resolveFileLink(room, from, undefined, outsideBase)).toThrow('outside this session')
    expect(() => resolveFileLink(room, from, undefined, 'docs/base.md')).toThrow('base file is invalid')
    expect(() => resolveFileLink(room, from, undefined, project)).toThrow('base path must be a file')
  })

  it('does not URL-decode the current document again for same-document headings', () => {
    const from = put(join(project, '100%20 done #part.md'))
    put(join(project, '100  done #part.md'))
    expect(resolveFileLink(room, '#intro', undefined, from)).toEqual({ path: from, isDirectory: false, fragment: 'intro' })
  })

  it('returns directories distinctly and reports missing files', () => {
    expect(resolveFileLink(room, '.')).toEqual({ path: project, isDirectory: true })
    expect(() => resolveFileLink(room, 'missing.md')).toThrow('no longer exists')
  })

  it('rejects sibling traversal and unrelated open-room files', () => {
    const path = put(join(outside, 'secret.md'))
    expect(() => resolveFileLink(room, path)).toThrow('outside this session')
    expect(() => resolveFileLink(room, '../project-sibling/secret.md')).toThrow('outside this session')
    expect(() => resolveFileLink(room, '..%2fproject-sibling%2fsecret.md')).toThrow('outside this session')
    expect(pathInsideRoots(path, [project])).toBe(false)
  })

  it('checks both lexical and real paths for symlink escapes', () => {
    const secret = put(join(outside, 'secret.md'))
    const safe = put(join(project, 'safe.md'))
    symlinkSync(secret, join(project, 'escape.md'))
    symlinkSync(safe, join(project, 'safe-link.md'))
    symlinkSync(safe, join(outside, 'outside-link.md'))
    expect(() => resolveFileLink(room, 'escape.md')).toThrow('outside this session')
    expect(() => resolveFileLink(room, join(outside, 'outside-link.md'))).toThrow('outside this session')
    expect(resolveFileLink(room, 'safe-link.md').path).toBe(join(project, 'safe-link.md'))
    symlinkSync(outside, join(project, 'escape-directory'))
    expect(() => resolveFileLink(room, 'escape-directory/secret.md')).toThrow('outside this session')
  })

  it('supports a project folder that is itself a symlink', () => {
    const path = put(join(project, 'safe.md'))
    const alias = join(directory, 'project-alias')
    symlinkSync(project, alias)
    expect(resolveFileLink({ ...room, folder: alias }, join(alias, 'safe.md')).path).toBe(join(alias, 'safe.md'))
    expect(pathInsideRoots(path, [alias])).toBe(false)
  })

  it.each([
    'https://example.com/a.md', '//server/shared/a.md', 'file://remote-server/tmp/a.md',
    'file:/tmp/a.md', 'file:///tmp/a.md?query=1', 'javascript:alert(1)', 'data:text/html,test',
    'unknown:document', 'vscode://file/tmp/a', 'C:\\Users\\file.md', 'a.md\u0000', 'a.md\n',
    'bad%ZZ.md', 'bad%00.md', 'bad%0a.md', '', '   '
  ])('rejects unsupported or malformed reference %j', (href) => {
    expect(() => resolveFileLink(room, href)).toThrow()
  })

  it.each(['file.md:0', 'file.md:12:0', 'file.md:99999999999999999999', 'file.md#L0'])('rejects invalid positions %s', (href) => {
    put(join(project, 'file.md'))
    expect(() => resolveFileLink(room, href)).toThrow('invalid line or column')
  })
})

describe('bounded raw document previews', () => {
  it('passes range requests through and streams the original response body with PDF MIME', async () => {
    const path = put(join(project, 'sample.PDF'), '0'.repeat(100))
    const request = new Request('iface://file/document', { headers: { Range: 'bytes=20-29', 'If-Range': statSync(path).mtime.toUTCString(), Cookie: 'ignored' } })
    const source = new Response('PDF bytes!', { status: 200 })
    const fetchFile = vi.fn().mockResolvedValue(source)
    const result = await filePreviewResponse(request, path, [project], fetchFile)
    expect(fetchFile.mock.calls[0][0]).toMatch(/^file:\/\//)
    const options = fetchFile.mock.calls[0][1] as RequestInit
    expect(new Headers(options.headers).get('range')).toBe('bytes=20-29')
    expect(new Headers(options.headers).get('cookie')).toBeNull()
    expect(result.status).toBe(206)
    expect(result.body).toBe(source.body)
    expect(result.headers.get('content-type')).toBe('application/pdf')
    expect(result.headers.get('content-range')).toBe('bytes 20-29/100')
    expect(result.headers.get('content-length')).toBe('10')
    expect(result.headers.get('accept-ranges')).toBe('bytes')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await result.text()).toBe('PDF bytes!')
  })

  it.each([
    ['bytes=3-', 'bytes=3-9', 'bytes 3-9/10', '7'],
    ['bytes=-3', 'bytes=7-9', 'bytes 7-9/10', '3'],
    ['bytes=9-100', 'bytes=9-9', 'bytes 9-9/10', '1']
  ])('normalizes native file ranges for %s', async (input, forwarded, result, length) => {
    const path = put(join(project, 'sample.pdf'), '0123456789')
    const fetchFile = vi.fn().mockResolvedValue(new Response('bytes'))
    const response = await filePreviewResponse(new Request('iface://file/pdf', { headers: { Range: input } }), path, [project], fetchFile)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(result)
    expect(response.headers.get('content-length')).toBe(length)
    expect(new Headers(fetchFile.mock.calls[0][1].headers).get('range')).toBe(forwarded)
  })

  it.each(['bytes=10-', 'bytes=4-3', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=a', 'bytes=-'])('returns 416 without loading unavailable range %s', async (range) => {
    const path = put(join(project, 'sample.pdf'), '0123456789')
    const fetchFile = vi.fn()
    const response = await filePreviewResponse(new Request('iface://file/pdf', { headers: { Range: range } }), path, [project], fetchFile)
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('serves the complete file for a stale If-Range or HEAD request', async () => {
    const path = put(join(project, 'sample.pdf'), '0123456789')
    const fetchFile = vi.fn().mockResolvedValue(new Response(null))
    for (const method of ['GET', 'HEAD']) {
      const response = await filePreviewResponse(new Request('iface://file/pdf', { method, headers: { Range: 'bytes=0-3', 'If-Range': 'stale' } }), path, [project], fetchFile)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBe('10')
      expect(response.headers.get('content-range')).toBeNull()
      expect(new Headers(fetchFile.mock.lastCall![1].headers).get('range')).toBeNull()
    }
  })

  it('uses image MIME and prevents SVG scripts or remote subresources', async () => {
    const path = put(join(project, 'diagram.svg'))
    const response = await filePreviewResponse(new Request('iface://file/document'), path, [project], async () => new Response('<svg/>'))
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects HTML, JavaScript, outside roots, directories, and non-read requests without fetching', async () => {
    const fetchFile = vi.fn()
    const request = new Request('iface://file/document')
    expect((await filePreviewResponse(request, put(join(project, 'page.html')), [project], fetchFile)).status).toBe(415)
    expect((await filePreviewResponse(request, put(join(project, 'app.js')), [project], fetchFile)).status).toBe(415)
    expect((await filePreviewResponse(request, put(join(outside, 'image.png')), [project], fetchFile)).status).toBe(403)
    mkdirSync(join(project, 'directory.pdf'))
    expect((await filePreviewResponse(request, join(project, 'directory.pdf'), [project], fetchFile)).status).toBe(404)
    expect((await filePreviewResponse(new Request(request.url, { method: 'POST' }), project, [project], fetchFile)).status).toBe(405)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('rejects attachment-style symlink escapes and reports loader failures', async () => {
    const secret = put(join(outside, 'secret.png'))
    symlinkSync(secret, join(project, 'escape.png'))
    const fetchFile = vi.fn().mockRejectedValue(new Error('File disappeared'))
    const request = new Request('iface://attachment/room/image.png')
    expect((await filePreviewResponse(request, join(project, 'escape.png'), [project], fetchFile)).status).toBe(403)
    expect(fetchFile).not.toHaveBeenCalled()
    const image = put(join(project, 'image.png'))
    expect((await filePreviewResponse(request, image, [project], fetchFile)).status).toBe(404)
  })
})
