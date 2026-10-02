// Read-only access to the project folders that rooms are open in, plus light
// directory watching for the file tree.

import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileContent, FileEntry } from '@shared/types'

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', '.next', 'dist', 'out', '.cache'])
const MAX_PREVIEW = 512 * 1024
const OUTSIDE_ROOT = 'That path is outside your open folders.'

interface DirectoryWatch {
  references: number
  watcher?: FSWatcher
  timer?: NodeJS.Timeout
  retry?: NodeJS.Timeout
  dev?: number
  ino?: number
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

export class Files {
  private watchers = new Map<string, DirectoryWatch>()

  constructor(
    private roots: () => string[],
    private onChange: (dir: string) => void
  ) {}

  private allowedPath(path: string): string {
    const full = resolve(path)
    if (!this.roots().some((root) => contains(resolve(root), full))) throw new Error(OUTSIDE_ROOT)
    return full
  }

  /** Check both the requested path and the destination of any symlinks. */
  private check(path: string): string {
    const full = this.allowedPath(path)
    const real = realpathSync(full)
    const ok = this.roots().some((root) => {
      try {
        return contains(realpathSync(resolve(root)), real)
      } catch {
        return false // A room may still reference a folder that was removed.
      }
    })
    if (!ok) throw new Error(OUTSIDE_ROOT)
    return real
  }

  async list(dir: string, showHidden = false): Promise<FileEntry[]> {
    try {
      const entries = await readdir(this.check(dir), { withFileTypes: true })
      return entries
        .filter((e) => showHidden || !HIDDEN.has(e.name))
        .map((e) => ({ name: e.name, path: join(resolve(dir), e.name), isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  async read(path: string): Promise<FileContent> {
    const fh = await open(this.check(path), 'r')
    try {
      const info = await fh.stat()
      const size = Math.min(info.size, MAX_PREVIEW)
      const buf = Buffer.alloc(size)
      let length = 0
      while (length < size) {
        const { bytesRead } = await fh.read(buf, length, size - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const content = buf.subarray(0, length)
      const binary = content.subarray(0, 8000).includes(0)
      return { content: binary ? '' : content.toString('utf8'), truncated: info.size > MAX_PREVIEW, binary, size: info.size }
    } finally {
      await fh.close()
    }
  }

  /** File paths under a folder for @-mentions when it is not a git repo. */
  async quickList(root: string, limit = 4000): Promise<string[]> {
    const base = this.allowedPath(root)
    try {
      this.check(base)
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const out: string[] = []
    const queue: string[] = [base]
    while (queue.length && out.length < limit) {
      const dir = queue.shift() as string
      let entries
      try {
        entries = await readdir(this.check(dir), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (HIDDEN.has(e.name) || e.name === '.collab') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) queue.push(full)
        else if (e.isFile()) out.push(relative(base, full))
        else if (e.isSymbolicLink()) {
          try {
            if (statSync(this.check(full)).isFile()) out.push(relative(base, full))
          } catch {
            // Skip broken links and links outside the open folders; never recurse into links.
          }
        }
        if (out.length >= limit) break
      }
    }
    return out
  }

  watch(dir: string): void {
    const full = this.allowedPath(dir)
    try {
      this.check(full)
    } catch (error) {
      // Missing or inaccessible folders can recover, but a symlink escape is rejected.
      if (!(error as NodeJS.ErrnoException)?.code) throw error
    }
    const current = this.watchers.get(full)
    if (current) {
      current.references++
      return
    }
    const entry: DirectoryWatch = { references: 1 }
    this.watchers.set(full, entry)
    this.attach(full, entry)
  }

  private changed(dir: string, entry: DirectoryWatch): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (this.watchers.get(dir) === entry) this.onChange(dir)
    }, 250)
    entry.timer.unref()
  }

  private attach(dir: string, entry: DirectoryWatch): void {
    if (this.watchers.get(dir) !== entry) return
    try {
      const real = this.check(dir)
      const info = statSync(real)
      if (!info.isDirectory()) {
        this.retry(dir, entry)
        return
      }
      const watcher = watch(real, { persistent: false }, (event) => {
        if (entry.watcher !== watcher) return
        this.changed(dir, entry)
        if (event === 'rename') {
          try {
            const current = statSync(this.check(dir))
            if (current.dev === entry.dev && current.ino === entry.ino) return
          } catch {
            // Linux watches the old inode when a directory is deleted and recreated.
          }
          this.detach(entry)
          this.attach(dir, entry)
        }
      })
      entry.watcher = watcher
      entry.dev = info.dev
      entry.ino = info.ino
      const disconnected = (): void => {
        if (entry.watcher !== watcher) return
        this.detach(entry)
        this.changed(dir, entry)
        this.retry(dir, entry)
      }
      watcher.on('error', disconnected)
      watcher.on('close', disconnected)
    } catch (error) {
      // Do not keep retrying a path whose room was closed or symlink left the roots.
      if ((error as NodeJS.ErrnoException)?.code) this.retry(dir, entry)
    }
  }

  private retry(dir: string, entry: DirectoryWatch): void {
    if (entry.retry || this.watchers.get(dir) !== entry) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      this.attach(dir, entry)
      if (entry.watcher) this.changed(dir, entry)
    }, 1000)
    entry.retry.unref()
  }

  private detach(entry: DirectoryWatch): void {
    const watcher = entry.watcher
    entry.watcher = undefined
    watcher?.close()
  }

  private dispose(dir: string, entry: DirectoryWatch): void {
    this.watchers.delete(dir)
    clearTimeout(entry.timer)
    clearTimeout(entry.retry)
    this.detach(entry)
  }

  unwatch(dir: string): void {
    const full = resolve(dir)
    const entry = this.watchers.get(full)
    if (entry && --entry.references === 0) this.dispose(full, entry)
  }

  closeAll(): void {
    for (const [dir, entry] of this.watchers) this.dispose(dir, entry)
  }
}
