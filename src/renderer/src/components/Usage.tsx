import type { Account, AccountInfo } from '@shared/types'
import { useEffect, useState } from 'react'
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
    <button className="account-row" onClick={() => openSettings('accounts')} title={info?.email ?? account.name}>
      <div className="account-row-head">
        <AgentMark provider={account.provider} color={account.color} size={16} />
        <span className="account-name">{account.name}</span>
        {info?.plan && <span className="plan">{info.plan}</span>}
      </div>
      <UsageBars info={info} compact />
    </button>
  )
}

export function AccountsUsage() {
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  return (
    <div className="accounts-usage">
      <div className="usage-title">
        <span>Accounts and limits</span>
        <button
          className="icon-btn tiny"
          title="Refresh usage"
          onClick={() => accounts.forEach((a) => void window.iface.refreshAccount(a.id))}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {accounts.map((a) => (
        <AccountRow key={a.id} account={a} />
      ))}
    </div>
  )
}
