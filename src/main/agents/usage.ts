// Turns each harness's own usage report into the same list of limits the UI shows.

import type { UsageLimit } from '@shared/types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const CLAUDE_KIND: Record<string, string> = {
  session: '5-hour session',
  weekly_all: 'Weekly · all models',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet',
  weekly_oauth_apps: 'Weekly · apps',
  weekly_cowork: 'Weekly · Cowork'
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** A limit's scope: newer Claude Code sends `{ model: { display_name }, surface }` objects. */
function scopeName(scope: unknown): string {
  if (typeof scope === 'string' || typeof scope === 'number') return String(scope)
  if (!scope || typeof scope !== 'object') return ''
  const s = scope as Json
  const name = (v: unknown): string => {
    if (typeof v === 'string' || typeof v === 'number') return String(v)
    const o = (v ?? {}) as Json
    const found = o.display_name ?? o.displayName ?? o.name ?? o.id
    return typeof found === 'string' || typeof found === 'number' ? String(found) : ''
  }
  const parts = [name(s.model), name(s.surface)].filter(Boolean)
  return parts.length ? parts.join(' · ') : name(s)
}

function money(minor: number | null | undefined, decimals = 2, currency = 'USD'): string {
  if (minor == null) return ''
  const v = minor / 10 ** decimals
  return currency === 'USD' ? `$${v.toFixed(2)}` : `${v.toFixed(2)} ${currency}`
}

/** Claude Code `get_usage` control response → limits and notes. */
export function claudeLimits(usage: Json): { limits: UsageLimit[]; notes: string[]; plan?: string } {
  const limits: UsageLimit[] = []
  const notes: string[] = []
  const rl = usage?.rate_limits ?? {}
  const shares: Json[] = Array.isArray(rl.weekly_scoped_shares) ? rl.weekly_scoped_shares : []
  const all: Json[] = Array.isArray(rl.limits) ? rl.limits : []
  all.forEach((l, index) => {
    const scope = scopeName(l.scope)
    const kind = typeof l.kind === 'string' ? l.kind : 'limit'
    const label = scope ? `${titleCase(l.group ?? kind)} · ${scope}` : (CLAUDE_KIND[kind] ?? titleCase(kind))
    const share = shares.find((s) => s?.limit_index === index)
    const allowance = Number(share?.allowance_percent_of_weekly)
    limits.push({
      id: `${kind}${scope ? `:${scope.toLowerCase()}` : ''}`,
      label,
      percent: Math.max(0, Math.min(100, Number(l.percent ?? 0))),
      resetsAt: l.resets_at ? Date.parse(l.resets_at) : undefined,
      severity: l.severity === 'critical' || l.severity === 'warning' ? l.severity : 'normal',
      ...(scope && Number.isFinite(allowance) && allowance > 0 ? { detail: `${scope} can use up to ${allowance}% of the weekly limit` } : {})
    })
  })
  if (!limits.length) {
    // Older Claude Code: fall back to the raw windows.
    for (const [key, label] of [
      ['five_hour', '5-hour session'],
      ['seven_day', 'Weekly · all models'],
      ['seven_day_opus', 'Weekly · Opus'],
      ['seven_day_sonnet', 'Weekly · Sonnet']
    ] as const) {
      const w = rl[key]
      if (w?.utilization == null) continue
      limits.push({ id: key, label, percent: Number(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined })
    }
  }
  const extra = rl.extra_usage
  if (extra?.is_enabled && extra.monthly_limit != null) {
    const dec = extra.decimal_places ?? 2
    limits.push({
      id: 'extra_monthly',
      label: 'Monthly extra usage',
      percent: Number(extra.utilization ?? 0),
      detail: `${money(extra.used_credits, dec, extra.currency)} of ${money(extra.monthly_limit, dec, extra.currency)}`
    })
  } else if (extra) {
    notes.push('Extra usage is off')
  }
  const spend = rl.spend
  if (spend?.enabled && spend.used) {
    notes.push(`Usage credits spent: ${money(spend.used.amount_minor, spend.used.exponent, spend.used.currency)}`)
  }
  const rows: Json[] = Array.isArray(rl.seven_day_breakdown?.rows) ? rl.seven_day_breakdown.rows : []
  const used = rows
    .filter((r) => typeof r?.display_name === 'string' && Number(r.percent) > 0)
    .sort((a, b) => Number(b.percent) - Number(a.percent))
  if (used.length) notes.push(`This week by app: ${used.map((r) => `${r.display_name} ${Math.round(Number(r.percent))}%`).join(' · ')}`)
  return { limits, notes, plan: usage?.subscription_type }
}

/** Claude Code `rate_limit_event` → limits (used between full refreshes). */
export function claudeRateEvent(info: Json): UsageLimit[] {
  const w = info?.unifiedWindows ?? {}
  const out: UsageLimit[] = []
  if (w.five_hour) out.push({ id: 'session', label: '5-hour session', percent: Math.round((w.five_hour.utilization ?? 0) * 100), resetsAt: w.five_hour.resetsAt ? w.five_hour.resetsAt * 1000 : undefined })
  if (w.seven_day) out.push({ id: 'weekly_all', label: 'Weekly · all models', percent: Math.round((w.seven_day.utilization ?? 0) * 100), resetsAt: w.seven_day.resetsAt ? w.seven_day.resetsAt * 1000 : undefined })
  return out
}

function windowLabel(mins: number | null | undefined): string {
  if (!mins) return 'Limit'
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'Weekly'
  if (mins >= 40000 && mins <= 45000) return 'Monthly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  if (mins % 60 === 0) return `${mins / 60}-hour`
  return `${mins}-minute`
}

/** Codex `account/rateLimits/read` (or the updated notification) → limits and notes. */
export function codexLimits(res: Json): { limits: UsageLimit[]; notes: string[]; plan?: string } {
  const limits: UsageLimit[] = []
  const notes: string[] = []
  const snapshots: Json[] = []
  const byId = res?.rateLimitsByLimitId
  if (byId && typeof byId === "object" && Object.keys(byId).length) snapshots.push(...(Object.values(byId) as Json[]))
  else if (res?.rateLimits) snapshots.push(res.rateLimits)
  else if (res?.primary || res?.secondary) snapshots.push(res)
  let plan: string | undefined
  for (const s of snapshots) {
    plan = plan ?? s.planType ?? undefined
    const prefix = s.limitName && s.limitId !== 'codex' ? `${s.limitName} · ` : ''
    for (const [slot, w] of [
      ['primary', s.primary],
      ['secondary', s.secondary]
    ] as const) {
      if (!w) continue
      limits.push({
        id: `${s.limitId ?? 'codex'}:${slot}`,
        label: `${prefix}${windowLabel(w.windowDurationMins)}`,
        percent: Math.max(0, Math.min(100, Number(w.usedPercent ?? 0))),
        resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
        severity: w.usedPercent >= 90 ? 'critical' : w.usedPercent >= 75 ? 'warning' : 'normal'
      })
    }
    const c = s.credits
    if (c?.unlimited) notes.push('Unlimited credits')
    else if (c?.hasCredits) notes.push(`Credits: ${c.balance}`)
    if (s.rateLimitReachedType) notes.push(`Limit reached: ${titleCase(String(s.rateLimitReachedType))}`)
  }
  const resets = res?.rateLimitResetCredits?.availableCount
  if (resets) notes.push(`${resets} free limit reset${resets === 1 ? '' : 's'} available`)
  return { limits, notes, plan: plan ?? res?.rateLimits?.planType }
}
