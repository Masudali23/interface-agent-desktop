import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

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
