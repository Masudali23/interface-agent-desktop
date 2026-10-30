import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requireFolder, Store } from '../src/main/store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storeWith(room: Record<string, unknown>): Store {
  const dir = mkdtempSync(join(tmpdir(), 'interface-store-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'rooms'))
  writeFileSync(join(dir, 'rooms', `${room.id}.json`), JSON.stringify(room))
  return new Store(dir)
}

describe('loading saved rooms', () => {
  it('turns a message queued for a turn that cannot continue into ordinary input', () => {
    const store = storeWith({
      id: 'r1', title: 'Saved', folder: '/project', kind: 'claude', createdAt: 0, updatedAt: 0, members: [],
      autoRelay: true, maxHops: 6, isolation: false, sessions: {},
      messages: [
        { id: 'm1', author: 'user', createdAt: 100, text: 'First', blocks: [], status: 'done', to: ['a'], deliveredTo: ['a'] },
        { id: 'm2', author: 'a', createdAt: 110, text: '', blocks: [
          { kind: 'text', id: 'x1', text: 'Working', at: 120 },
          { kind: 'tool', id: 't1', name: 'Bash', input: {}, status: 'running', at: 200 }
        ], status: 'streaming' },
        { id: 'm3', author: 'user', createdAt: 150, text: 'Later', blocks: [], status: 'done', to: ['a'], deliveredTo: [], queued: true }
      ]
    })
    const room = store.get('r1')!
    const [user, reply, queued] = room.messages
    expect(user.sentAt).toBeUndefined()
    expect(reply.status).toBe('stopped')
    expect(reply.blocks[1]).toMatchObject({ status: 'error', at: 200 })
    expect(queued.queued).toBeUndefined()
    // Sent after the turn it waited behind, which kept working after it was written.
    expect(queued.sentAt).toBe(201)
    expect(store.takeReleased()).toEqual([{ room, message: queued }])
    expect(store.takeReleased()).toEqual([])
    // Saved at once, so a second load does not release it again.
    const saved = JSON.parse(readFileSync(join(dirs[0], 'rooms', 'r1.json'), 'utf8'))
    expect(saved.messages[2].queued).toBeUndefined()
    expect(saved.messages[2].sentAt).toBe(201)
    expect(new Store(dirs[0]).takeReleased()).toEqual([])
  })

  it('releases nothing when no message was queued', () => {
    const store = storeWith({
      id: 'r2', title: 'Saved', folder: '/project', kind: 'claude', createdAt: 0, updatedAt: 0, members: [],
      autoRelay: true, maxHops: 6, isolation: false, sessions: {},
      messages: [{ id: 'm1', author: 'user', createdAt: 100, text: 'First', blocks: [], status: 'done' }]
    })
    expect(store.takeReleased()).toEqual([])
  })
})

describe('projects', () => {
  function tempDir(prefix = 'interface-project-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  function storeWithSettings(settings: Record<string, unknown>, rooms: Array<Record<string, unknown>> = []): { store: Store; dir: string } {
    const dir = tempDir('interface-store-')
    mkdirSync(join(dir, 'rooms'))
    for (const room of rooms) writeFileSync(join(dir, 'rooms', `${room.id}.json`), JSON.stringify(room))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
    return { store: new Store(dir), dir }
  }

  const room = (id: string, folder: string, updatedAt = 0) => ({
    id, title: id, folder, kind: 'claude', createdAt: 0, updatedAt, members: [],
    autoRelay: true, maxHops: 6, isolation: false, sessions: {}, messages: []
  })
  const savedProjects = (dir: string): string[] => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).projects.map((p: { folder: string }) => p.folder)

  it('starts from the recently used folders that still exist and saves the list once', () => {
    const existing = tempDir()
    const { store, dir } = storeWithSettings({ recentFolders: [existing, '/missing/interface-project'] })
    expect(store.settings.projects).toEqual([{ folder: existing, addedAt: 0 }])
    expect(savedProjects(dir)).toEqual([existing])
  })

  it('makes every session folder a project, including folders that are gone, newest session first', () => {
    const existing = tempDir()
    const { store, dir } = storeWithSettings({ recentFolders: [existing] }, [
      room('r1', '/unmounted/older', 10),
      room('r2', '/unmounted/newer', 20),
      room('r3', `${existing}/`, 30)
    ])
    expect(store.projectFolders()).toEqual([existing, '/unmounted/newer', '/unmounted/older'])
    expect(savedProjects(dir)).toEqual([existing, '/unmounted/newer', '/unmounted/older'])
  })

  it('keeps saved projects in order without malformed or repeated entries, ignoring recent folders', () => {
    const recent = tempDir()
    const { store } = storeWithSettings({
      recentFolders: [recent],
      projects: [{ folder: '/a', addedAt: 5 }, { folder: '/a/', addedAt: 9 }, { folder: 3 }, null, { folder: '/b' }]
    })
    expect(store.settings.projects).toEqual([{ folder: '/a', addedAt: 5 }, { folder: '/b', addedAt: 0 }])
  })

  it('keeps an emptied project list empty after a restart', () => {
    const { store } = storeWithSettings({ recentFolders: [tempDir()], projects: [] })
    expect(store.settings.projects).toEqual([])
  })

  it('adds a project at the top, moves a repeated one there and saves the list', () => {
    const { store, dir } = storeWithSettings({ projects: [{ folder: '/a', addedAt: 1 }, { folder: '/b', addedAt: 2 }] })
    store.addProject('/c')
    store.addProject('/b/')
    expect(store.projectFolders()).toEqual(['/b/', '/c', '/a'])
    expect(store.settings.projects[0].addedAt).toBeGreaterThan(2)
    store.removeProject('/c')
    expect(savedProjects(dir)).toEqual(['/b/', '/a'])
  })

  it('refuses to remove a project that still has sessions', () => {
    const { store } = storeWithSettings({ projects: [{ folder: '/work/api', addedAt: 1 }] }, [room('r1', '/work/api')])
    expect(() => store.removeProject('/work/api/')).toThrow('still has sessions')
    expect(store.projectFolders()).toEqual(['/work/api'])
  })

  it('accepts only folders that exist', () => {
    const folder = tempDir()
    expect(requireFolder(`${folder}/`)).toBe(folder)
    const file = join(folder, 'notes.txt')
    writeFileSync(file, 'x')
    expect(() => requireFolder(file)).toThrow('is missing')
    expect(() => requireFolder(join(folder, 'gone'))).toThrow('is missing')
  })
})
