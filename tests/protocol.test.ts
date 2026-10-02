import { describe, expect, it } from 'vitest'
import { parseMentions } from '../src/shared/mentions'
import { DEFAULT_SETTINGS, type Member, type Message, type Room } from '../src/shared/types'
import { formatUpdate, parseHandoff, pendingFor, renderMessage, systemPrompt, titleFrom } from '../src/main/protocol'
import { unwrapShell } from '../src/main/agents/codex'
import { claudeLimits, codexLimits } from '../src/main/agents/usage'

const member = (id: string, handle: string, provider: 'claude' | 'codex'): Member => ({
  id,
  accountId: `acc-${id}`,
  provider,
  name: handle,
  handle,
  color: '#000',
  settings: { ...DEFAULT_SETTINGS }
})

const team: Room = {
  id: 'r1',
  title: 't',
  folder: '/tmp/p',
  kind: 'team',
  createdAt: 0,
  updatedAt: 0,
  members: [member('a', 'claude', 'claude'), member('b', 'gpt', 'codex'), member('c', 'work', 'claude')],
  autoRelay: true,
  maxHops: 6,
  isolation: false,
  sessions: {},
  messages: []
}
const solo: Room = { ...team, kind: 'claude', members: [team.members[0]] }

const msg = (p: Partial<Message>): Message => ({
  id: Math.random().toString(36),
  author: 'user',
  createdAt: 0,
  text: '',
  blocks: [],
  status: 'done',
  ...p
})

describe('parseHandoff', () => {
  it('reads a hand-off to another member by handle and removes the line', () => {
    const r = parseHandoff('Built the API.\n\n→ @gpt: build the form in ui.tsx', team, 'a')
    expect(r.handoff).toEqual({ to: 'b', text: 'build the form in ui.tsx' })
    expect(r.body).toBe('Built the API.')
  })

  it('resolves custom handles, ASCII arrows and bold markdown', () => {
    expect(parseHandoff('ok\n**-> @work:** please review', team, 'a').handoff).toEqual({ to: 'c', text: 'please review' })
    expect(parseHandoff('ok\n→ @user: which database?', team, 'a').handoff).toEqual({ to: 'user', text: 'which database?' })
    expect(parseHandoff('All good.\n→ DONE', team, 'a').handoff).toEqual({ to: 'done', text: '' })
    expect(parseHandoff('x\n→ @user: `gpt.txt` is ready', team, 'b').handoff?.text).toBe('`gpt.txt` is ready')
  })

  it('maps @codex to the only Codex member, but not an ambiguous @claude', () => {
    expect(parseHandoff('x\n→ @codex: go', team, 'a').handoff?.to).toBe('b')
    // Two Claude members besides nobody: from b, "@claude" is the member with handle "claude".
    expect(parseHandoff('x\n→ @claude: go', team, 'b').handoff?.to).toBe('a')
  })

  it('ignores unknown handles and arrows far from the end', () => {
    expect(parseHandoff('x\n→ @nobody: go', team, 'a').handoff).toBeUndefined()
    expect(parseHandoff(['→ @gpt: old', 'a', 'b', 'c', 'd', 'e'].join('\n'), team, 'a').handoff).toBeUndefined()
  })

  it('reads model and effort overrides without including them in the delegated task', () => {
    const result = parseHandoff('API ready\n→ @gpt [model=gpt-6-sol effort=low]: Review api.ts', team, 'a')
    expect(result).toEqual({
      body: 'API ready',
      handoff: { to: 'b', text: 'Review api.ts', overrides: { model: 'gpt-6-sol', effort: 'low' } }
    })
  })

  it.each([
    '[urgent] Review api.ts',
    '[urgent]: Review api.ts',
    '[docs](https://example.com/api): Review these docs'
  ])('preserves ordinary bracketed handoff text: %s', (task) => {
    expect(parseHandoff(`API ready\n→ @gpt ${task}`, team, 'a')).toEqual({
      body: 'API ready', handoff: { to: 'b', text: task }
    })
  })

  it('keeps settings-looking task text after the handoff colon as text', () => {
    expect(parseHandoff('→ @gpt: [model=default] is an example to document', team, 'a').handoff).toEqual({
      to: 'b', text: '[model=default] is an example to document'
    })
  })

  it.each([
    '[model=]: Review',
    '[model =gpt-6-sol]: Review',
    '[effort==low]: Review',
    '[model=gpt-6-sol effrot=low]: Review',
    '[model=gpt-6-sol effort=low: Review'
  ])('rejects malformed delegation settings: %s', (task) => {
    const handoff = parseHandoff(`→ @gpt ${task}`, team, 'a').handoff
    expect(handoff?.to).toBe('b')
    expect(handoff?.error).toBeTruthy()
  })

  it('supports partial settings and an explicit reset to the harness default', () => {
    expect(parseHandoff('→ @work [effort=high]: Review', team, 'a').handoff).toEqual({ to: 'c', text: 'Review', overrides: { effort: 'high' } })
    expect(parseHandoff('→ @gpt [model=default effort=default]: Review', team, 'a').handoff).toEqual({ to: 'b', text: 'Review', overrides: { model: '', effort: '' } })
  })

  it('marks unsupported delegation settings as errors for the orchestrator to block', () => {
    const result = parseHandoff('→ @gpt [model=gpt-6-sol sandbox=full]: Review', team, 'a')
    expect(result.handoff).toMatchObject({ to: 'b', text: 'Review', overrides: { model: 'gpt-6-sol' } })
    expect(result.handoff?.error).toBeTruthy()
    expect(result.handoff?.overrides).not.toHaveProperty('sandbox')
  })

  it('keeps delegation overrides when forwarding or saving a handoff as text', () => {
    const original = parseHandoff('API ready\n→ @gpt [model=default effort=low]: Review api.ts', team, 'a')
    const rendered = renderMessage(msg({ author: 'a', text: original.body, handoff: original.handoff }), team)
    expect(parseHandoff(rendered, team, 'a').handoff).toEqual(original.handoff)
  })
})

describe('parseMentions', () => {
  const m = team.members
  it('finds members by handle, provider name or @both', () => {
    expect(parseMentions('@work do x', m)).toEqual(['c'])
    expect(parseMentions('hey @gpt', m)).toEqual(['b'])
    expect(parseMentions('@claude backend', m)).toEqual(['a'])
    expect(parseMentions('@both start', m)?.sort()).toEqual(['a', 'b', 'c'])
    expect(parseMentions('email me@claude.ai', m)).toBeUndefined()
    expect(parseMentions('@claude do it, then hand off to @gpt', m)).toEqual(['a'])
    expect(parseMentions('@claude backend, @gpt frontend', m)?.sort()).toEqual(['a', 'b'])
    expect(parseMentions('@claude and @work: compare notes', m)?.sort()).toEqual(['a', 'c'])
    expect(parseMentions('Quick question.\n@gpt what is this?', m)).toEqual(['b'])
    expect(parseMentions('no mention', m)).toBeUndefined()
  })
})

describe('forwarding', () => {
  it('skips own, streaming and already delivered messages', () => {
    const a = msg({ text: 'hi' })
    const b = msg({ author: 'a', text: 'mine' })
    const c = msg({ author: 'b', text: 'theirs' })
    const d = msg({ author: 'b', status: 'streaming' })
    const e = msg({ deliveredTo: ['a'] })
    expect(pendingFor('a', [a, b, c, d, e])).toEqual([a, c])
  })

  it('sends solo rooms exactly what was typed, with no room protocol', () => {
    expect(formatUpdate(solo.members[0], [msg({ text: '/compact' })], solo)).toBe('/compact')
    expect(systemPrompt(solo.members[0], solo)).toBeUndefined()
  })

  it('wraps team updates and lists every other member in the rules', () => {
    const text = formatUpdate(team.members[1], [msg({ text: 'hello', to: ['b'] })], team)
    expect(text).toContain('<room-update>')
    expect(text).toContain('### USER → @gpt\nhello')
    const rules = systemPrompt(team.members[0], team)!
    expect(rules).toContain('→ @gpt:')
    expect(rules).toContain('→ @work:')
    expect(rules).not.toContain('→ @claude:')
  })
})

describe('usage', () => {
  it('reads Claude limits', () => {
    const r = claudeLimits({
      subscription_type: 'pro',
      rate_limits: {
        limits: [
          { kind: 'session', group: 'session', percent: 47, resets_at: '2026-10-02T00:59:59Z', severity: 'normal' },
          { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: '2026-10-08T13:59:59Z' }
        ],
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD', decimal_places: 2 }
      }
    })
    expect(r.limits.map((l) => [l.label, l.percent])).toEqual([
      ['5-hour session', 47],
      ['Weekly · all models', 12],
      ['Monthly extra usage', 25]
    ])
    expect(r.limits[2].detail).toBe('$12.50 of $50.00')
    expect(r.plan).toBe('pro')
  })

  it('reads Codex limits', () => {
    const r = codexLimits({
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 2 }, planType: 'plus' }
      },
      rateLimitResetCredits: { availableCount: 2 }
    })
    expect(r.limits.map((l) => [l.label, l.percent])).toEqual([
      ['5-hour', 30],
      ['Weekly', 2]
    ])
    expect(r.notes).toContain('2 free limit resets available')
    expect(r.plan).toBe('plus')
  })
})

describe('helpers', () => {
  it('unwraps Codex shell commands', () => {
    expect(unwrapShell("/bin/bash -lc 'wc -c a.txt'")).toBe('wc -c a.txt')
    expect(unwrapShell('/bin/zsh -lc "ls -la"')).toBe('ls -la')
  })
  it('makes short titles', () => {
    expect(titleFrom('@both please build a login page with email and password and tests')).toBe('please build a login page with email')
  })
})
