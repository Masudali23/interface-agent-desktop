import type { ClaudePermissionMode, CodexMode } from '@shared/types'

export const PERMISSION_MODES: Array<{ value: ClaudePermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Ask permissions', hint: 'Asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits go through, commands still ask' },
  { value: 'plan', label: 'Plan mode', hint: 'Reads and plans, changes nothing' },
  { value: 'auto', label: 'Auto', hint: 'A safety check approves routine actions' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks. Risky' }
]

export const CODEX_MODES: Array<{ value: CodexMode; label: string; hint: string }> = [
  { value: 'read-only', label: 'Read only', hint: 'Reads files, asks before any change' },
  { value: 'ask', label: 'Ask every time', hint: 'Asks before running commands' },
  { value: 'auto', label: 'Auto', hint: 'Edits this folder, asks for anything outside' },
  { value: 'full', label: 'Full access', hint: 'No sandbox, never asks. Risky' }
]

export const effortLabel = (e: string): string => (e ? e[0].toUpperCase() + e.slice(1) : 'Default')
