import { describe, expect, it } from 'vitest'
import type { AccountInfo, RoomKind, RoomSummary } from '@shared/types'
import { groupSessions, isSearchShortcut, matchSessions, paletteKey, parentPath, parseList, searchBlocked, shortcut, toggleItem, topLimit, visibleSessions } from '../src/renderer/src/lib/chrome'

const room = (id: string, folder: string, kind: RoomKind = 'claude', extra: Partial<RoomSummary> = {}): RoomSummary => ({
  id,
  title: `Session ${id}`,
  folder,
  kind,
  updatedAt: 0,
  members: [],
  ...extra
})

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

describe('sidebar groups', () => {
  it('keeps one mode, puts pinned sessions first and groups the rest by folder in recency order', () => {
    const rooms = [
      room('a', '/work/api'),
      room('b', '/work/web', 'team'),
      room('c', '/work/web'),
      room('d', '/work/api', 'claude', { pinned: true }),
      room('e', '/work/api')
    ]
    const groups = groupSessions(rooms, 'claude')
    expect(groups.pinned.map((r) => r.id)).toEqual(['d'])
    expect(groups.folders).toEqual([
      { folder: '/work/api', rooms: [rooms[0], rooms[4]] },
      { folder: '/work/web', rooms: [rooms[2]] }
    ])
    expect(groupSessions(rooms, 'codex')).toEqual({ pinned: [], folders: [] })
  })

  it('shows only the open session of a collapsed group', () => {
    const list = [room('a', '/p'), room('b', '/p')]
    expect(visibleSessions(list, false, 'b')).toEqual(list)
    expect(visibleSessions(list, true, 'b')).toEqual([list[1]])
    expect(visibleSessions(list, true, 'elsewhere')).toEqual([])
    expect(visibleSessions(list, true)).toEqual([])
  })
})

describe('remembered lists', () => {
  it('reads only a JSON array of strings', () => {
    expect(parseList(null)).toEqual([])
    expect(parseList('not json')).toEqual([])
    expect(parseList('{"a":1}')).toEqual([])
    expect(parseList('["/a", 3, "/b"]')).toEqual(['/a', '/b'])
  })

  it('toggles an item without changing the input', () => {
    const list = ['/a']
    expect(toggleItem(list, '/b')).toEqual(['/a', '/b'])
    expect(toggleItem(list, '/a')).toEqual([])
    expect(list).toEqual(['/a'])
  })
})

describe('session search', () => {
  const rooms = [
    room('1', '/code/interface', 'claude', { title: 'Fix the composer' }),
    room('2', '/code/site', 'codex', { title: 'Landing page composer' }),
    room('3', '/code/composer-kit', 'team', { title: 'Release notes' }),
    room('4', '/code/site', 'claude', { title: 'Unrelated' })
  ]

  it('matches every word in the title or folder and ranks title prefixes first', () => {
    expect(matchSessions(rooms, 'composer').map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(matchSessions(rooms, 'land').map((r) => r.id)).toEqual(['2'])
    expect(matchSessions(rooms, 'site unrelated').map((r) => r.id)).toEqual(['4'])
    expect(matchSessions(rooms, 'release').map((r) => r.id)).toEqual(['3'])
    expect(matchSessions(rooms, 'kit').map((r) => r.id)).toEqual(['3'])
  })

  it('puts a title that starts with the query before one that only contains it', () => {
    expect(matchSessions(rooms, 'LANDING composer').map((r) => r.id)).toEqual(['2'])
    expect(matchSessions(rooms, 'fix').map((r) => r.id)).toEqual(['1'])
    const ranked = matchSessions([room('x', '/a', 'claude', { title: 'The composer' }), room('y', '/composer', 'claude', { title: 'Other' }), room('z', '/a', 'claude', { title: 'Composer bug' })], 'composer')
    expect(ranked.map((r) => r.id)).toEqual(['z', 'x', 'y'])
  })

  it('returns nothing for an empty query and respects the limit', () => {
    expect(matchSessions(rooms, '   ')).toEqual([])
    expect(matchSessions(rooms, 'code', 2)).toHaveLength(2)
  })
})

describe('folder paths', () => {
  it('shows the containing folder on macOS, Linux and Windows paths', () => {
    expect(parentPath('/Users/me/code/app')).toBe('/Users/me/code')
    expect(parentPath('/Users/me/code/app/')).toBe('/Users/me/code')
    expect(parentPath('/app')).toBe('/')
    expect(parentPath('C:\\work\\app')).toBe('C:\\work')
    expect(parentPath('app')).toBe('')
  })
})

describe('usage', () => {
  it('picks the limit closest to running out', () => {
    const info: AccountInfo = {
      limits: [
        { id: 'session', label: '5-hour session', percent: 12 },
        { id: 'weekly', label: 'Weekly', percent: 64 },
        { id: 'opus', label: 'Weekly · Opus', percent: 30 }
      ],
      notes: []
    }
    expect(topLimit(info)?.id).toBe('weekly')
    expect(topLimit({ limits: [], notes: [] })).toBeUndefined()
    expect(topLimit(undefined)).toBeUndefined()
  })
})

describe('shortcuts', () => {
  it('uses Cmd on macOS and Ctrl elsewhere for search', () => {
    expect(isSearchShortcut(key('k', { metaKey: true }), 'darwin')).toBe(true)
    expect(isSearchShortcut(key('K', { metaKey: true }), 'darwin')).toBe(true)
    expect(isSearchShortcut(key('k', { ctrlKey: true }), 'darwin')).toBe(false)
    expect(isSearchShortcut(key('k', { ctrlKey: true }), 'linux')).toBe(true)
    expect(isSearchShortcut(key('k', { metaKey: true }), 'linux')).toBe(false)
    expect(isSearchShortcut(key('k', { metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isSearchShortcut(key('j', { metaKey: true }), 'darwin')).toBe(false)
  })

  it('leaves Ctrl+K to a focused terminal on Linux', () => {
    expect(isSearchShortcut(key('k', { ctrlKey: true }), 'linux', true)).toBe(false)
    expect(isSearchShortcut(key('k', { metaKey: true }), 'darwin', true)).toBe(true)
  })

  it('writes shortcuts the way each platform does', () => {
    expect(shortcut('darwin', 'K')).toBe('⌘K')
    expect(shortcut('linux', 'K')).toBe('Ctrl+K')
  })
})

describe('search palette', () => {
  it('does not open over Settings or New session', () => {
    expect(searchBlocked({ settingsOpen: false })).toBe(false)
    expect(searchBlocked({ settingsOpen: true })).toBe(true)
    expect(searchBlocked({ settingsOpen: false, newSession: { kind: 'claude' } })).toBe(true)
  })

  it('maps the keys the whole dialog handles, wherever focus is inside it', () => {
    expect(paletteKey('Escape')).toBe('close')
    expect(paletteKey('ArrowUp')).toBe('up')
    expect(paletteKey('ArrowDown')).toBe('down')
    expect(paletteKey('Enter')).toBe('open')
    expect(paletteKey('Tab')).toBe('stay')
    expect(paletteKey('a')).toBeUndefined()
  })
})
