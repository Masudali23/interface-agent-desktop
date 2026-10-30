import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activitySummary, elapsedText, estimateTokens, relative, resetText, runtimeActivity, tokens, toolLabel, toolProgress, untilText, usageText } from '../src/renderer/src/lib/format'
import type { Block, Message } from '../src/shared/types'

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

describe('activity rows', () => {
  const tool = (id: string, name: string, input: unknown = {}, status: 'running' | 'done' | 'error' = 'done'): Block => ({ kind: 'tool', id, name, input, status })

  it('summarises a run of steps in past tense, in the order they happened', () => {
    const blocks: Block[] = [
      { kind: 'thinking', id: 'th', text: 'plan' },
      tool('1', 'Bash', { command: 'ls' }),
      tool('2', 'Read', { file_path: '/p/a.ts' }),
      tool('3', 'Bash', { command: 'npm test' }),
      tool('4', 'Edit', { file_path: '/p/a.ts' }),
      tool('5', 'Write', { file_path: '/p/b.ts' }),
      tool('6', 'Edit', { file_path: '/p/a.ts' })
    ]
    expect(activitySummary(blocks)).toEqual({ text: 'Ran 2 commands, read a file, edited 2 files', failed: 0 })
  })

  it('names searches, pages, plans, agents and other tools', () => {
    expect(activitySummary([tool('1', 'Grep', { pattern: 'x' }), tool('2', 'WebFetch', { url: 'https://a' })]).text).toBe('Searched files, fetched a page')
    expect(activitySummary([tool('1', 'Glob'), tool('2', 'Grep'), tool('3', 'TodoWrite'), tool('4', 'Plan')]).text).toBe('Ran 2 searches, updated the plan')
    expect(activitySummary([tool('1', 'Web search'), tool('2', 'Task')]).text).toBe('Searched the web, ran an agent')
    expect(activitySummary([tool('1', 'ToolSearch', { query: 'select:TaskCreate' }), tool('2', 'TaskCreate', { subject: 'A' }), tool('3', 'TaskUpdate', { taskId: '1', status: 'completed' }), tool('4', 'Bash')]).text).toBe('Loaded tools, updated the plan, ran a command')
    expect(toolProgress('TaskUpdate')).toBe('Updating the plan')
    expect(toolProgress('ToolSearch')).toBe('Loading tools')
    expect(activitySummary([tool('1', 'mcp__matlab__evaluate_code')]).text).toBe('Used evaluate code')
    expect(activitySummary([tool('1', 'docs: lookup'), tool('2', 'other')]).text).toBe('Used 2 tools')
    expect(activitySummary([tool('1', 'Edit files', { changes: [{ path: '/a' }, { path: '/b' }] })]).text).toBe('Edited 2 files')
  })

  it('says "Thought" for thinking alone and counts failures', () => {
    expect(activitySummary([{ kind: 'thinking', id: 't', text: '' }])).toEqual({ text: 'Thought', failed: 0 })
    expect(activitySummary([tool('1', 'Bash', {}, 'error'), tool('2', 'Bash')])).toEqual({ text: 'Ran 2 commands', failed: 1 })
  })

  it('describes running tools and agent states in the present', () => {
    expect(toolProgress('Bash')).toBe('Running a command')
    expect(toolProgress('Shell')).toBe('Running a command')
    expect(toolProgress('Read')).toBe('Reading a file')
    expect(toolProgress('MultiEdit')).toBe('Editing a file')
    expect(toolProgress('Grep')).toBe('Searching')
    expect(toolProgress('WebFetch')).toBe('Fetching a page')
    expect(toolProgress('WebSearch')).toBe('Searching the web')
    expect(toolProgress('Agent')).toBe('Running an agent')
    expect(toolProgress('mcp__github__create_issue')).toBe('Using create issue')
    expect(toolLabel('server: tool')).toBe('tool')
    expect(runtimeActivity({ status: 'thinking' })).toBe('Thinking')
    expect(runtimeActivity({ status: 'thinking', detail: 'retrying' })).toBe('Retrying')
    expect(runtimeActivity({ status: 'working', detail: 'Bash' })).toBe('Running a command')
    expect(runtimeActivity({ status: 'working', detail: 'compacting' })).toBe('Compacting the conversation')
    expect(runtimeActivity({ status: 'working' })).toBe('Working')
    expect(runtimeActivity({ status: 'waiting', detail: 'Bash' })).toBe('Waiting for you')
    expect(runtimeActivity({ status: 'starting' })).toBe('Starting')
    expect(runtimeActivity({ status: 'idle' })).toBe('')
    expect(runtimeActivity(undefined)).toBe('')
  })

  it('formats running time and estimates output size', () => {
    expect(elapsedText(0)).toBe('0s')
    expect(elapsedText(38_900)).toBe('38s')
    expect(elapsedText(64_000)).toBe('1m 4s')
    expect(elapsedText((62 * 60 + 5) * 1000)).toBe('1h 2m')
    expect(elapsedText(-5)).toBe('0s')
    const message: Message = { id: 'm', author: 'a', createdAt: 0, text: '', status: 'streaming', blocks: [
      { kind: 'text', id: 't', text: 'x'.repeat(4000) },
      { kind: 'thinking', id: 'th', text: 'y'.repeat(800) },
      tool('b', 'Bash', { command: 'ls' })
    ] }
    expect(estimateTokens(message)).toBe(Math.round((4000 + 800 + JSON.stringify({ command: 'ls' }).length) / 4))
    expect(`${tokens(1234)} tokens`).toBe('1.2k tokens')
  })
})
