import { describe, expect, it } from 'vitest'
import { agentEnv } from '../src/main/env'

describe('agent environment', () => {
  it('turns on Claude Code task list tools for Claude accounts only, after dropping inherited Claude settings', () => {
    const saved = { ...process.env }
    process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0'
    process.env.CLAUDECODE = '1'
    try {
      const claude = agentEnv({ provider: 'claude', home: '/accounts/second' })
      expect(claude.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
      expect(claude.CLAUDE_CONFIG_DIR).toBe('/accounts/second')
      expect(claude.CLAUDECODE).toBeUndefined()
      const codex = agentEnv({ provider: 'codex' })
      expect(codex.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBeUndefined()
      expect(codex.CODEX_HOME).toBeUndefined()
    } finally {
      process.env = saved
    }
  })
})
