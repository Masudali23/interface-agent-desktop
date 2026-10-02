import { describe, expect, it } from 'vitest'
import { addUsage } from '../src/main/agents/claude'
import { neverAsks } from '../src/main/rooms'

const member = (provider: 'claude' | 'codex', settings: Record<string, string>) => ({ provider, settings }) as never

describe('full access never asks', () => {
  it('Codex Full access and Claude Bypass skip approvals', () => {
    expect(neverAsks(member('codex', { codexMode: 'full', permissionMode: 'default' }))).toBe(true)
    expect(neverAsks(member('claude', { codexMode: 'auto', permissionMode: 'bypassPermissions' }))).toBe(true)
  })
  it('every other mode still asks', () => {
    expect(neverAsks(member('codex', { codexMode: 'auto', permissionMode: 'bypassPermissions' }))).toBe(false)
    expect(neverAsks(member('claude', { codexMode: 'full', permissionMode: 'auto' }))).toBe(false)
  })
})

describe('one reply spanning two Claude Code results', () => {
  it('adds the usage of both', () => {
    const a = { inputTokens: 100, cachedTokens: 60, outputTokens: 10, steps: 2, durationMs: 1000 }
    const b = { inputTokens: 50, cachedTokens: 40, outputTokens: 5, steps: 1, durationMs: 500 }
    expect(addUsage(a, b)).toEqual({ inputTokens: 150, cachedTokens: 100, outputTokens: 15, steps: 3, durationMs: 1500 })
    expect(addUsage(undefined, b)).toBe(b)
  })
})
