import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relative, resetText, tokens, untilText, usageText } from '../src/renderer/src/lib/format'

const NOW = new Date('2026-10-02T12:00:00Z').getTime()
const MIN = 60000

it('shortens file paths only within the project directory', () => {
  expect(relative('/project/file.ts', '/project')).toBe('file.ts')
  expect(relative('/project/file.ts', '/project/')).toBe('file.ts')
  expect(relative('/project-other/file.ts', '/project')).toBe('/project-other/file.ts')
  expect(relative('/file.ts', '/')).toBe('file.ts')
  expect(relative('C:\\project\\file.ts', 'C:\\project')).toBe('file.ts')
})

describe('reset countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('shows hours and minutes', () => {
    expect(untilText(NOW + (3 * 60 + 5) * MIN)).toBe('3 hr 5 min')
    expect(untilText(NOW + 2 * 60 * MIN)).toBe('2 hr')
    expect(untilText(NOW + 45 * MIN)).toBe('45 min')
  })

  it('rounds partial minutes up and never shows 60 min', () => {
    expect(untilText(NOW + 30 * 1000)).toBe('1 min')
    expect(untilText(NOW + (2 * 60 - 0.5) * MIN)).toBe('2 hr')
  })

  it('shows days for long windows', () => {
    expect(untilText(NOW + (24 * 60 + 90) * MIN)).toBe('1 day 1 hr')
    expect(untilText(NOW + 5 * 24 * 60 * MIN)).toBe('5 days')
  })

  it('handles past and missing times', () => {
    expect(untilText(NOW - MIN)).toBe('now')
    expect(resetText(NOW - MIN)).toBe('resets soon')
    expect(resetText(undefined)).toBe('')
    expect(resetText(NOW + 65 * MIN)).toBe('resets in 1 hr 5 min')
  })
})

describe('reply usage footer', () => {
  it('shows new input, output and steps, keeping cache re-reads in the tooltip', () => {
    const u = { inputTokens: 3_311_000, cachedTokens: 3_215_000, outputTokens: 12_000, steps: 21, durationMs: 226_000 }
    const { text, title } = usageText(u)
    expect(text).toBe('21 steps · 96k in · 12k out · 3m 46s')
    expect(title).toContain('3.2M re-read from cache')
    expect(title).toContain('3.3M input in total')
  })
  it('keeps the old format for replies saved before the split', () => {
    expect(usageText({ inputTokens: 5000, outputTokens: 300 }).text).toBe('5.0k in · 300 out')
  })
  it('writes millions as M', () => {
    expect(tokens(3_311_000)).toBe('3.3M')
    expect(tokens(12_000)).toBe('12k')
  })
})
