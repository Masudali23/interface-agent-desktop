import type { Block, Message } from './types'
import { parseUnifiedDiff } from './diff'
import { createTwoFilesPatch } from 'diff'

export interface CodexFileChange {
  /** The destination path for a move, otherwise the recorded path. */
  path: string
  oldPath?: string
  kind: 'add' | 'delete' | 'update'
  /** A unified patch; empty when no patch/content was supplied. */
  diff: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function filePath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : undefined
}

/** Shared metadata extraction keeps activity detection independent of patch size. */
function codexFileMetadata(change: unknown): Omit<CodexFileChange, 'diff'> | undefined {
  const input = record(change)
  if (!input) return undefined
  const source = filePath(input.path)
  if (!source) return undefined
  const nativeKind = record(input.kind)
  const kind = input.kind == null ? 'update' : typeof input.kind === 'string' ? input.kind : nativeKind?.type
  if (kind !== 'add' && kind !== 'delete' && kind !== 'update') return undefined
  const move = kind === 'update' ? filePath(nativeKind?.move_path) ?? filePath(nativeKind?.movePath) ?? filePath(input.move_path) ?? filePath(input.movePath) : undefined
  const path = move ?? source
  const oldPath = move && move !== source ? source : filePath(input.oldPath) ?? filePath(input.old_path)
  return { path, kind, ...(oldPath && oldPath !== path ? { oldPath } : {}) }
}

/**
 * Codex additions/deletions carry raw file contents in `diff`, even when those
 * contents look like patch headers. Updates already contain a unified patch.
 * An explicit empty string represents an empty file; omitted contents stay absent.
 */
export function codexFileChange(change: unknown): CodexFileChange | undefined {
  const metadata = codexFileMetadata(change)
  if (!metadata) return undefined
  const raw = record(change)!.diff
  let diff = typeof raw === 'string' ? raw : ''
  if (typeof raw === 'string') {
    if (metadata.kind === 'add') diff = createTwoFilesPatch('/dev/null', metadata.path, '', raw)
    else if (metadata.kind === 'delete') diff = createTwoFilesPatch(metadata.path, '/dev/null', raw, '')
  }
  return { ...metadata, diff }
}

export function editedPaths(block: Block): string[] {
  if (block.kind !== 'tool' || block.status === 'error') return []
  const input = block.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return []
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(block.name)) {
    const path = input.file_path ?? input.notebook_path
    return typeof path === 'string' && path ? [path] : []
  }
  if (block.name === 'Edit files' && Array.isArray(input.changes)) {
    return input.changes.flatMap((change) => {
      const metadata = codexFileMetadata(change)
      return metadata ? [metadata.path] : []
    })
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
