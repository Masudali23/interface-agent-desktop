import type { Account, AccountInfo } from '@shared/types'
import { useEffect, useState } from 'react'
import { topLimit } from '../lib/chrome'
import { useStoredList } from '../lib/frame'
import { resetAt, resetText, untilText } from '../lib/format'
import { useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

/** Re-renders every 30 seconds so reset countdowns stay current. */
function useTick(): void {
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
}

export function UsageBars({ info, compact = false }: { info?: AccountInfo; compact?: boolean }) {
  useTick()
  if (!info) return <div className="usage-empty">Checking…</div>
  if (info.loggedIn === false) return <div className="usage-empty warn">Not signed in</div>
  if (info.error && !info.limits.length) return <div className="usage-empty warn" title={info.error}>Couldn't read usage</div>
  if (!info.limits.length) return <div className="usage-empty">No limits reported</div>
  const limits = compact ? info.limits.slice(0, 3) : info.limits
  return (
    <div className={`usage-bars ${compact ? 'compact' : ''}`}>
      {limits.map((l) => {
        const hot = l.severity === 'critical' || l.percent >= 90 ? 'hot' : l.severity === 'warning' || l.percent >= 75 ? 'warm' : ''
        return (
          <div key={l.id} className="meter" title={`${l.label}: ${Math.round(l.percent)}% used${l.resetsAt ? `, ${resetText(l.resetsAt)} (${resetAt(l.resetsAt)})` : ''}${l.detail ? ` (${l.detail})` : ''}`}>
            <div className="meter-label">
              <span>{l.label}</span>
              <span>
                {Math.round(l.percent)}%{l.resetsAt ? <em> · {compact ? untilText(l.resetsAt) : resetText(l.resetsAt)}</em> : null}
              </span>
            </div>
            <div className="meter-track">
              <div className={`meter-fill ${hot}`} style={{ width: `${Math.min(100, l.percent)}%` }} />
            </div>
            {!compact && l.detail ? <div className="meter-detail">{l.detail}</div> : null}
          </div>
        )
      })}
      {!compact && info.notes.length > 0 && (
        <ul className="usage-notes">
          {info.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AccountRow({ account }: { account: Account }) {
  const info = useApp((s) => s.accountInfo[account.id])
  const openSettings = useApp((s) => s.openSettings)
  return (
    <button className="sb-account" onClick={() => openSettings('accounts')} title={info?.email ?? account.name}>
      <div className="sb-account-head">
        <AgentMark provider={account.provider} color={account.color} size={16} />
        <span className="sb-account-name">{account.name}</span>
        {info?.plan && <span className="sb-account-plan">{info.plan}</span>}
      </div>
      <UsageBars info={info} compact />
    </button>
  )
}

/** One mark per account with the share of its tightest limit, shown while the list is folded. */
function AccountsSummary({ accounts }: { accounts: Account[] }) {
  const info = useApp((s) => s.accountInfo)
  return (
    <span className="sb-accounts-summary">
      {accounts.map((a) => {
        const top = topLimit(info[a.id])
        return (
          <span key={a.id} className="sb-accounts-chip" title={top ? `${a.name}: ${top.label} ${Math.round(top.percent)}% used` : a.name}>
            <AgentMark provider={a.provider} color={a.color} size={12} />
            {top ? `${Math.round(top.percent)}%` : null}
          </span>
        )
      })}
    </span>
  )
}

export function AccountsUsage() {
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  const [folded, toggle] = useStoredList('iface.accountsFolded')
  const collapsed = folded.includes('accounts')
  if (!accounts.length) return null
  return (
    <section className={`sb-accounts ${collapsed ? 'collapsed' : ''}`}>
      <div className="sb-accounts-head">
        <button className="sb-group-toggle" aria-expanded={!collapsed} onClick={() => toggle('accounts')}>
          <span className="sb-group-name">Accounts and limits</span>
          <Icon name="caretDown" size={10} className="sb-caret" />
        </button>
        {collapsed ? (
          <AccountsSummary accounts={accounts} />
        ) : (
          <button className="icon-btn tiny" title="Refresh usage" onClick={() => accounts.forEach((a) => void window.iface.refreshAccount(a.id))}>
            <Icon name="refresh" size={12} />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="sb-accounts-list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </div>
      )}
    </section>
  )
}
