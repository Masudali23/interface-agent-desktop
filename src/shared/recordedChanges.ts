import { createTwoFilesPatch } from 'diff'
import { codexFileChange, editedPaths } from './changes'
import { parseUnifiedDiff } from './diff'
import type { GitFile, Message, Room } from './types'

export interface RecordedEdit {
  diff: string
  messageId: string
  author: string
  authorName?: string
  createdAt: number
  excerpt: boolean
  undone?: boolean
}
export interface RecordedFile extends GitFile { edits: RecordedEdit[] }
type ReviewRoom = Pick<Room, 'folder' | 'members' | 'messages'>
type EditMessage = Pick<Message, 'id' | 'author' | 'authorName' | 'createdAt' | 'diff' | 'undone'> & {
  root: string
  tools: Array<{ name: string; input: unknown; paths: string[] }>
}

function relative(path: string, root: string): string {
  const prefix = root.replace(/[\\/]+$/, '') + '/'
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

function collect(messages: EditMessage[]): RecordedFile[] {
  const files = new Map<string, RecordedFile>()
  const add = (path: string, diff: string, message: EditMessage, excerpt = false, status?: string, oldPath?: string): void => {
    path = relative(path, message.root)
    const parsed = parseUnifiedDiff(diff, path)
    const entry = files.get(path) ?? { path, status: 'recorded', added: 0, removed: 0, edits: [] }
    entry.status = status ?? parsed[0]?.status ?? 'recorded'
    entry.oldPath = oldPath ? relative(oldPath, message.root) : undefined
    entry.binary = parsed.some((file) => file.binary)
    entry.added = (entry.added ?? 0) + parsed.reduce((n, f) => n + f.added, 0)
    entry.removed = (entry.removed ?? 0) + parsed.reduce((n, f) => n + f.removed, 0)
    entry.edits.push({ diff, messageId: message.id, author: message.author, authorName: message.authorName, createdAt: message.createdAt, excerpt, undone: message.undone })
    files.set(path, entry)
  }
  for (const message of messages) {
    if (message.diff) {
      const patches = message.diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim())
      for (const patch of patches) {
        const file = parseUnifiedDiff(patch)[0]
        if (file) add(file.path, patch, message, false, file.status, file.oldPath)
      }
      continue
    }
    for (const tool of message.tools) {
      const input = (tool.input ?? {}) as Record<string, unknown>
      if (tool.name === 'Edit files' && Array.isArray(input.changes)) {
        for (const raw of input.changes) {
          const change = codexFileChange(raw)
          if (change) add(change.path, change.diff, message, false, change.kind === 'add' ? 'added' : change.kind === 'delete' ? 'deleted' : change.oldPath ? 'renamed' : 'modified', change.oldPath)
        }
      } else if (tool.name === 'Write') {
        add(tool.paths[0], createTwoFilesPatch(tool.paths[0], tool.paths[0], '', text(input.content)), message, true)
      } else if (tool.name === 'Edit' || tool.name === 'MultiEdit') {
        const edits = tool.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input]
        for (const edit of edits) {
          if (edit && typeof edit === 'object') add(tool.paths[0], createTwoFilesPatch(tool.paths[0], tool.paths[0], text(edit.old_string), text(edit.new_string)), message, true)
        }
      } else add(tool.paths[0], '', message, true)
    }
  }
  return [...files.values()]
}

// IPC supplies fresh objects while a reply streams. Compare just edit inputs and
// metadata, without serializing/copying all patch text into a render-time key.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

/** A panel-local cache: streaming text and usage do not rebuild recorded patches. */
export function createRecordedChangesSelector(): (room: ReviewRoom, turn?: string) => RecordedFile[] {
  let previous: EditMessage[] = [], result: RecordedFile[] = []
  return (room, turn = '') => {
    const next: EditMessage[] = []
    for (const message of room.messages) {
      if (message.author === 'user' || (turn && message.id !== turn)) continue
      const tools: EditMessage['tools'] = []
      if (!message.diff) for (const block of message.blocks) {
        if (block.kind !== 'tool' || block.status !== 'done') continue
        const paths = editedPaths(block)
        if (paths.length) tools.push({ name: block.name, input: block.input, paths })
      }
      if (message.diff || tools.length) next.push({
        id: message.id, author: message.author, authorName: message.authorName,
        createdAt: message.createdAt, diff: message.diff, undone: message.undone,
        root: room.members.find((member) => member.id === message.author)?.worktree?.path ?? room.folder,
        tools
      })
    }
    if (!equal(previous, next)) { result = collect(next); previous = next }
    return result
  }
}
