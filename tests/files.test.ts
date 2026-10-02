import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Files } from '../src/main/files'

const watchMock = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: watchMock
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})

class TestWatcher extends EventEmitter {
  close = vi.fn(() => this.emit('close'))
}

let folder: string
let root: string
let outside: string
let services: Files[]
let watches: { watcher: TestWatcher; change: (event: 'rename' | 'change', filename: string | null) => void }[]

function files(roots: () => string[] = () => [root], changed = vi.fn()): Files {
  const service = new Files(roots, changed)
  services.push(service)
  return service
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'interface-files-'))
  root = join(folder, 'project')
  outside = join(folder, 'project-other')
  await Promise.all([mkdir(root), mkdir(outside)])
  services = []
  watches = []
  watchMock.mockReset()
  watchMock.mockImplementation((_dir: string, _options: unknown, change: typeof watches[number]['change']) => {
    const watcher = new TestWatcher()
    watches.push({ watcher, change })
    return watcher
  })
})

afterEach(async () => {
  for (const service of services) service.closeAll()
  vi.useRealTimers()
  await rm(folder, { recursive: true, force: true })
})

describe('file boundaries and previews', () => {
  it('rejects sibling folders and symlinks that leave the open roots', async () => {
    const secret = join(outside, 'secret.txt')
    const link = join(root, 'escape')
    await writeFile(secret, 'private')
    await symlink(outside, link, 'dir')
    const service = files()
    for (const path of [outside, link]) {
      await expect(service.list(path)).rejects.toThrow('outside your open folders')
      await expect(service.quickList(path)).rejects.toThrow('outside your open folders')
      await expect(service.read(join(path, 'secret.txt'))).rejects.toThrow('outside your open folders')
      expect(() => service.watch(path)).toThrow('outside your open folders')
    }
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('supports filesystem roots and roots that are themselves symlinks', async () => {
    const file = join(root, 'hello.txt')
    await writeFile(file, 'hello')
    await expect(files(() => [parse(root).root]).read(file)).resolves.toMatchObject({ content: 'hello' })
    const alias = join(folder, 'alias')
    await symlink(root, alias, 'dir')
    const service = files(() => [alias])
    await expect(service.list(alias)).resolves.toEqual([{ name: 'hello.txt', path: join(alias, 'hello.txt'), isDir: false }])
    await expect(service.read(join(alias, 'hello.txt'))).resolves.toMatchObject({ content: 'hello' })
    await expect(service.quickList(alias)).resolves.toEqual(['hello.txt'])
  })

  it('skips hidden folders, escaping links and directory loops during file search', async () => {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, '.collab'))
    await writeFile(join(root, 'src', 'entry.ts'), 'export {}')
    await writeFile(join(root, 'node_modules', 'ignored.js'), '')
    await writeFile(join(root, '.collab', 'ignored.md'), '')
    await writeFile(join(outside, 'secret.txt'), 'private')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    await symlink(join(root, 'src', 'entry.ts'), join(root, 'alias.ts'))
    await symlink(root, join(root, 'src', 'loop'), 'dir')
    const service = files()
    expect((await service.quickList(root)).sort()).toEqual(['alias.ts', join('src', 'entry.ts')].sort())
    expect(await service.quickList(root, 1)).toHaveLength(1)
  })

  it('returns empty lists for removed folders without hiding boundary errors', async () => {
    const service = files()
    await rm(root, { recursive: true })
    await expect(service.list(root)).resolves.toEqual([])
    await expect(service.quickList(root)).resolves.toEqual([])
    await expect(service.list(join(outside, 'missing'))).rejects.toThrow('outside your open folders')
    await expect(service.read(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('caps previews and detects real binary data', async () => {
    const large = join(root, 'large.txt')
    await writeFile(large, 'x'.repeat(512 * 1024 + 5))
    const service = files()
    const preview = await service.read(large)
    expect(preview).toMatchObject({ truncated: true, binary: false, size: 512 * 1024 + 5 })
    expect(preview.content).toHaveLength(512 * 1024)
    const binary = join(root, 'binary')
    await writeFile(binary, Buffer.from([1, 0, 2]))
    await expect(service.read(binary)).resolves.toEqual({ content: '', truncated: false, binary: true, size: 3 })
  })

  it('uses only bytes actually read when a file shrinks and closes the handle', async () => {
    const file = join(root, 'shrinking.txt')
    await writeFile(file, 'before')
    const close = vi.fn(async () => undefined)
    const read = vi.fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        buffer.write('ok')
        return { bytesRead: 2, buffer }
      })
      .mockResolvedValueOnce({ bytesRead: 0 })
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ size: 50 }), read, close
    } as unknown as Awaited<ReturnType<typeof open>>)
    await expect(files().read(file)).resolves.toEqual({ content: 'ok', binary: false, truncated: false, size: 50 })
    expect(read).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the file handle if reading fails', async () => {
    const file = join(root, 'failed.txt')
    await writeFile(file, 'before')
    const close = vi.fn(async () => undefined)
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ size: 6 }),
      read: async () => { throw new Error('read failed') },
      close
    } as unknown as Awaited<ReturnType<typeof open>>)
    await expect(files().read(file)).rejects.toThrow('read failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('delivers native filesystem events after another consumer releases the directory', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    watchMock.mockImplementation(fs.watch)
    const changed = vi.fn()
    const service = files(undefined, changed)
    service.watch(root)
    // macOS can miss a write made before the native event stream finishes
    // registering. Warm it up with spaced probes before testing shared lifetime.
    let probe = 0
    await vi.waitFor(async () => {
      if (!changed.mock.calls.length) await writeFile(join(root, 'ready.txt'), String(++probe))
      expect(changed).toHaveBeenCalledWith(root)
    }, { interval: 400, timeout: 5000 })
    changed.mockClear()
    service.watch(root)
    service.unwatch(root)
    await writeFile(join(root, 'live.txt'), 'live change')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(root), { timeout: 3000 })
    service.unwatch(root)
  })
})

describe('directory watcher lifetime', () => {
  beforeEach(() => vi.useFakeTimers())

  it('shares one nonrecursive watcher until every consumer releases it', () => {
    const changed = vi.fn()
    const service = files(undefined, changed)
    service.watch(root)
    service.watch(join(root, '.'))
    expect(watchMock).toHaveBeenCalledOnce()
    expect(watchMock.mock.calls[0][1]).toEqual({ persistent: false })
    service.unwatch(root)
    expect(watches[0].watcher.close).not.toHaveBeenCalled()
    watches[0].change('change', 'file.txt')
    watches[0].change('change', 'file.txt')
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenCalledExactlyOnceWith(root)
    service.unwatch(root)
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    service.unwatch(root)
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels pending notifications and ignores events from a released watcher', () => {
    const changed = vi.fn()
    const service = files(undefined, changed)
    service.watch(root)
    watches[0].change('change', null)
    service.unwatch(root)
    service.watch(root)
    watches[0].change('change', 'stale.txt')
    vi.advanceTimersByTime(1000)
    expect(changed).not.toHaveBeenCalled()
    service.closeAll()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps all references when recovering from watcher errors', () => {
    const changed = vi.fn()
    const service = files(undefined, changed)
    service.watch(root)
    service.watch(root)
    watches[0].watcher.emit('error', new Error('watch failed'))
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    service.unwatch(root)
    expect(watches[1].watcher.close).not.toHaveBeenCalled()
    service.unwatch(root)
    expect(watches[1].watcher.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers when a watched directory is deleted and recreated', async () => {
    const changed = vi.fn()
    const service = files(undefined, changed)
    service.watch(root)
    await rm(root, { recursive: true })
    watches[0].change('rename', 'project')
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    await mkdir(root)
    vi.advanceTimersByTime(1000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenLastCalledWith(root)
    watches[1].change('change', 'new.txt')
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('can acquire missing directories and cancels recovery after the last release', () => {
    const service = files()
    const absent = join(root, 'not-created-yet')
    expect(() => service.watch(absent)).not.toThrow()
    service.watch(absent)
    expect(watchMock).not.toHaveBeenCalled()
    service.unwatch(absent)
    expect(vi.getTimerCount()).toBe(1)
    service.unwatch(absent)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('stops recovery if the folder is replaced by an escaping symlink', async () => {
    const child = join(root, 'child')
    await mkdir(child)
    const service = files()
    service.watch(child)
    await rm(child, { recursive: true })
    await symlink(outside, child, 'dir')
    watches[0].change('rename', 'child')
    vi.advanceTimersByTime(250)
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(watchMock).toHaveBeenCalledOnce()
  })

  it('closes multiply acquired watchers and all retry/debounce timers on shutdown', () => {
    const service = files()
    service.watch(root)
    service.watch(root)
    service.watch(join(root, 'missing'))
    watches[0].change('change', 'file.txt')
    service.closeAll()
    expect(watches[0].watcher.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
