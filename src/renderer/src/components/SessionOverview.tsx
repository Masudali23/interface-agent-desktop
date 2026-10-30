import { useEffect, useState, type ReactNode } from 'react'
import type { McpServer, Member, Room } from '@shared/types'
import { parentPath, topLimit } from '../lib/chrome'
import { useStoredList } from '../lib/frame'
import { basename, tokens, untilText } from '../lib/format'
import { useApp } from '../store'
import { AgentMark, Icon } from './Icon'

function Card({ id, title, aside, children, collapsed, toggle }: { id: string; title: string; aside?: ReactNode; children: ReactNode; collapsed: boolean; toggle: (id: string) => void }) {
  return (
    <section className={`so-card ${collapsed ? 'collapsed' : ''}`}>
      <div className="so-card-head">
        <button className="so-card-toggle" aria-expanded={!collapsed} onClick={() => toggle(id)}>
          <span>{title}</span>
          <Icon name="caretDown" size={10} className="sb-caret" />
        </button>
        {aside}
      </div>
      {!collapsed && <div className="so-card-body">{children}</div>}
    </section>
  )
}

function MemberLabel({ member }: { member: Member }) {
  return (
    <span className="so-member">
      <AgentMark provider={member.provider} color={member.color} size={14} />
      <span>{member.name}</span>
    </span>
  )
}

function Environment({ room }: { room: Room }) {
  const platform = useApp((s) => s.platform)
  const [branch, setBranch] = useState<string | null>()
  useEffect(() => {
    let live = true
    setBranch(undefined)
    window.iface
      .gitStatus(room.id)
      .then((git) => live && setBranch(git.isRepo ? git.branch ?? 'detached HEAD' : null))
      .catch(() => live && setBranch(null))
    return () => {
      live = false
    }
  }, [room.id])
  const isolated = room.members.filter((m) => m.worktree)
  return (
    <>
      <div className="so-row">
        <Icon name="monitor" size={15} />
        <span className="so-main">This computer</span>
        <span className="so-muted">{platform === 'darwin' ? 'macOS' : 'Linux'}</span>
      </div>
      <button className="so-row so-link" onClick={() => void window.iface.revealPath(room.folder)} title={`${room.folder}\nReveal folder`}>
        <Icon name="folder" size={15} />
        <span className="so-main">{basename(room.folder)}</span>
        <span className="so-muted so-path"><bdi>{parentPath(room.folder)}</bdi></span>
      </button>
      <div className="so-row">
        <Icon name="branch" size={15} />
        <span className="so-main">{branch === undefined ? 'Checking git…' : branch ?? 'Not a git repository'}</span>
      </div>
      {isolated.map((m) => (
        <div key={m.id} className="so-row so-nested" title={m.worktree!.path}>
          <MemberLabel member={m} />
          <span className="so-muted so-branch">{m.worktree!.branch}</span>
        </div>
      ))}
    </>
  )
}

function ContextRow({ room, member, team }: { room: Room; member: Member; team: boolean }) {
  const ctx = useApp((s) => s.statuses[room.id]?.[member.id]?.context)
  const pct = ctx ? Math.min(100, Math.max(0, Math.round(ctx.percent))) : undefined
  const level = pct === undefined ? '' : pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''
  return (
    <div className="so-context">
      <div className="so-row so-tight">
        {team ? <MemberLabel member={member} /> : <span className="so-main">Context window</span>}
        <span className="so-muted">{pct === undefined ? 'Not measured yet' : `${pct}%`}</span>
      </div>
      <div className="so-meter">
        <div className={`so-meter-fill ${level}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      {ctx && <div className="so-note">{tokens(ctx.used)} of {tokens(ctx.max)} tokens used</div>}
    </div>
  )
}

function serverTone(status: string): string {
  if (status === 'connected') return 'ok'
  if (status === 'disabled') return 'off'
  return status === 'failed' || status === 'authenticationRequired' ? 'bad' : 'wait'
}

/** Last list seen per room member. Listing a Claude member's servers starts its CLI (and
 *  every MCP server it has), so the overview only lists on request and otherwise shows this. */
const knownServers = new Map<string, McpServer[]>()
/** Refresh clicks already sent, so coming back to a room does not repeat one, and the
 *  lists still on their way (a remount picks these up instead of asking again). */
const answered = new Set<string>()
const inflight = new Map<string, Promise<McpServer[]>>()
/** Numbers every refresh click for the app's lifetime. A per-mount count would start over
 *  after a remount and hit a tick `answered` already holds, so that click would do nothing. */
let refreshSeq = 0

function Connectors({ room, member, team, tick }: { room: Room; member: Member; team: boolean; tick: number }) {
  const cacheKey = `${room.id}:${member.id}`
  const [servers, setServers] = useState<McpServer[] | undefined>(() => knownServers.get(cacheKey))
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setServers(knownServers.get(cacheKey))
    setError(undefined)
    setChecking(false)
    const ask = `${cacheKey}:${tick}`
    let job = inflight.get(ask)
    if (tick && !job && !answered.has(ask)) {
      answered.add(ask)
      job = window.iface.mcpList(room.id, member.id).then((list) => {
        knownServers.set(cacheKey, list)
        return list
      })
      inflight.set(ask, job)
      void job.catch(() => undefined).finally(() => inflight.delete(ask))
    }
    if (!job) return
    let live = true
    setChecking(true)
    job
      .then((list) => live && setServers(list))
      .catch((err: Error) => live && setError(err.message.replace(/^Error invoking remote method 'api': (Error: )?/, '')))
      .finally(() => live && setChecking(false))
    return () => {
      live = false
    }
  }, [cacheKey, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="so-group">
      {team && <div className="so-group-head"><MemberLabel member={member} /></div>}
      {error ? (
        <div className="so-note so-warn" title={error}>Couldn't list servers: {error}</div>
      ) : checking && !servers ? (
        <div className="so-note">Checking…</div>
      ) : !servers ? (
        <div className="so-note">Not checked yet. Use refresh to list servers.</div>
      ) : !servers.length ? (
        <div className="so-note">No MCP servers configured.</div>
      ) : (
        servers.map((s) => (
          <div key={s.name} className="so-row so-tight" title={[s.status, s.scope, s.error].filter(Boolean).join(' · ')}>
            <span className={`status-dot ${serverTone(s.status)}`} />
            <span className="so-main">{s.name}</span>
            {s.tools != null && <span className="so-muted">{s.tools} tools</span>}
          </div>
        ))
      )}
    </div>
  )
}

function AccountRow({ member }: { member: Member }) {
  const account = useApp((s) => s.settings?.accounts.find((a) => a.id === member.accountId))
  const info = useApp((s) => s.accountInfo[member.accountId])
  const openSettings = useApp((s) => s.openSettings)
  const top = topLimit(info)
  const status = !account ? 'Account removed' : info?.loggedIn === false ? 'Not signed in' : info?.plan ?? info?.email ?? ''
  return (
    <button className="so-account" onClick={() => openSettings('accounts')} title={info?.email ?? account?.name}>
      <div className="so-row so-tight">
        <AgentMark provider={member.provider} color={account?.color ?? member.color} size={14} />
        <span className="so-main">{account?.name ?? member.name}</span>
        <span className="so-muted">{status}</span>
      </div>
      {top && (
        <>
          <div className="so-meter">
            <div className={`so-meter-fill ${top.percent >= 90 ? 'hot' : top.percent >= 75 ? 'warm' : ''}`} style={{ width: `${Math.min(100, top.percent)}%` }} />
          </div>
          <div className="so-note">
            {top.label} · {Math.round(top.percent)}% used{top.resetsAt ? ` · resets in ${untilText(top.resetsAt)}` : ''}
          </div>
        </>
      )}
    </button>
  )
}

/** Claude-desktop-style overview of the session: where it runs, how full each agent's
 *  context is, which MCP servers it has and which account and limits it uses. */
export function SessionOverview({ room }: { room: Room }) {
  const setPanel = useApp((s) => s.setPanel)
  const [collapsed, toggle] = useStoredList('iface.overviewCollapsed')
  // Counted per room so switching sessions never lists (and starts) anything by itself.
  const [mcpAsk, setMcpAsk] = useState({ room: room.id, n: 0 })
  const mcpTick = mcpAsk.room === room.id ? mcpAsk.n : 0
  const team = room.members.length > 1
  const card = (id: string) => ({ id, collapsed: collapsed.includes(id), toggle })
  const refreshContext = (): void => {
    for (const m of room.members) void window.iface.refreshContext(room.id, m.id).catch(() => undefined)
  }
  // Ask for a fresh measurement once when the panel opens; idle agents answer right away.
  useEffect(refreshContext, [room.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="so">
      <Card title="Environment" {...card('environment')}>
        <Environment room={room} />
      </Card>
      <Card
        title="Context"
        {...card('context')}
        aside={
          <button className="icon-btn tiny" title="Measure again" aria-label="Refresh context" onClick={refreshContext}>
            <Icon name="refresh" size={12} />
          </button>
        }
      >
        {room.members.map((m) => (
          <ContextRow key={m.id} room={room} member={m} team={team} />
        ))}
      </Card>
      <Card
        title="Connectors"
        {...card('connectors')}
        aside={
          <span className="so-aside">
            <button className="icon-btn tiny" title="Check again" aria-label="Refresh connectors" onClick={() => setMcpAsk({ room: room.id, n: ++refreshSeq })}>
              <Icon name="refresh" size={12} />
            </button>
            <button className="so-link-btn" onClick={() => setPanel('mcp')}>Manage</button>
          </span>
        }
      >
        {room.members.map((m) => (
          <Connectors key={m.id} room={room} member={m} team={team} tick={mcpTick} />
        ))}
      </Card>
      <Card title={team ? 'Accounts' : 'Account'} {...card('account')}>
        {room.members.map((m) => (
          <AccountRow key={m.id} member={m} />
        ))}
      </Card>
    </div>
  )
}
