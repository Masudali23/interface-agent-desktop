// Session actions shared by the sidebar and the session header, and small UI choices
// (collapsed groups and cards) remembered between launches.

import { useState } from 'react'
import { act } from '../store'
import { parseList, toggleItem } from './chrome'

export function deleteSession(room: { id: string; title: string }): void {
  if (confirm(`Delete "${room.title}"? The conversation is removed from this app, and agent copies (worktrees) that weren't merged are deleted. Your project files stay.`)) {
    void act(() => window.iface.deleteRoom(room.id))
  }
}

export function setPinned(roomId: string, pinned: boolean): void {
  void act(() => window.iface.pinRoom(roomId, pinned))
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the choice lasts until the window reloads
  }
}

/** A remembered list of ids, e.g. collapsed sidebar groups, with a toggle that saves it. */
export function useStoredList(key: string): [string[], (item: string) => void] {
  const [list, setList] = useState(() => parseList(readStored(key)))
  const toggle = (item: string): void => {
    setList((current) => {
      const next = toggleItem(current, item)
      writeStored(key, JSON.stringify(next))
      return next
    })
  }
  return [list, toggle]
}
