import type { Block, Message } from './types'
import { parseUnifiedDiff } from './diff'

export function editedPaths(block: Block): string[] {
  if (block.kind !== 'tool' || block.status === 'error') return []
  const input = block.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return []
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(block.name)) {
    const path = input.file_path ?? input.notebook_path
    return typeof path === 'string' && path ? [path] : []
  }
  if (block.name === 'Edit files' && Array.isArray(input.changes)) {
    return input.changes.flatMap((change) => typeof change?.path === 'string' ? [change.path] : [])
  }
  return []
}

export function latestFileActivity(message: Message): { key: string; path: string } | undefined {
  for (let i = message.blocks.length - 1; i >= 0; i--) {
    const block = message.blocks[i]
    const path = editedPaths(block)[0]
    if (path && block.kind === 'tool' && block.status === 'done') return { key: `${message.id}:${block.id}:${path}`, path }
  }
  if (message.diff) {
    const path = parseUnifiedDiff(message.diff).at(-1)?.path
    if (path) return { key: `${message.id}:diff:${path}:${message.diff.length}`, path }
  }
  return undefined
}
