import { useEffect, useState } from 'react'
import { PROVIDER_LABEL, type Account, type RoomKind } from '@shared/types'
import { basename } from '../lib/format'
import { act, useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

const KINDS: Array<{ id: RoomKind; label: string; hint: string }> = [
  { id: 'claude', label: 'Claude Code', hint: 'One Claude Code agent, exactly like Claude desktop' },
  { id: 'codex', label: 'Codex', hint: 'One Codex agent, exactly like the Codex app' },
  { id: 'team', label: 'Team', hint: 'Several agents, any accounts, one shared conversation' }
]

function AccountOption({ account, checked, multi, onChange }: { account: Account; checked: boolean; multi: boolean; onChange: (on: boolean) => void }) {
  const info = useApp((s) => s.accountInfo[account.id])
  return (
    <label className={`account-option ${checked ? 'on' : ''}`}>
      <input type={multi ? 'checkbox' : 'radio'} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <AgentMark provider={account.provider} color={account.color} size={20} />
      <span className="ao-main">
        <span className="ao-name">
          {account.name} <span className="handle">@{account.handle}</span>
        </span>
        <span className="ao-detail">
          {PROVIDER_LABEL[account.provider]}
          {info?.loggedIn === false ? ' · not signed in' : info?.email ? ` · ${info.email}` : ''}
          {info?.plan ? ` · ${info.plan}` : ''}
        </span>
      </span>
    </label>
  )
}

export function NewSessionDialog() {
  const request = useApp((s) => s.newSession)
  const close = useApp((s) => s.closeNewSession)
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  const recent = useApp((s) => s.settings?.recentFolders ?? EMPTY)
  const openRoom = useApp((s) => s.openRoom)
  const openSettings = useApp((s) => s.openSettings)
  const [kind, setKind] = useState<RoomKind>('team')
  const [folder, setFolder] = useState<string>()
  const [picked, setPicked] = useState<string[]>([])
  const [isolation, setIsolation] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!request) return
    setKind(request.kind)
    setFolder(request.folder ?? recent[0])
    setIsolation(false)
  }, [request]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (kind === 'team') {
      const firstClaude = accounts.find((a) => a.provider === 'claude')
      const firstCodex = accounts.find((a) => a.provider === 'codex')
      setPicked([firstClaude?.id, firstCodex?.id].filter(Boolean) as string[])
    } else {
      setPicked(accounts.filter((a) => a.provider === kind).slice(0, 1).map((a) => a.id))
    }
  }, [kind, accounts.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!request) return null
  const list = kind === 'team' ? accounts : accounts.filter((a) => a.provider === kind)

  const browse = async (): Promise<void> => {
    const dir = await window.iface.pickFolder()
    if (dir) setFolder(dir)
  }

  const create = async (): Promise<void> => {
    if (!folder || !picked.length) return
    setCreating(true)
    const room = await act(() => window.iface.createRoom({ folder, kind, accountIds: picked, isolation }))
    setCreating(false)
    if (room) {
      close()
      await openRoom(room.id)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal new-session" role="dialog" aria-label="New session">
        <div className="modal-head">
          <h2>New session</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="kind-cards">
            {KINDS.map((k) => (
              <button key={k.id} className={`kind-card ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>
                <span className="kind-marks">
                  {k.id !== 'codex' && <AgentMark provider="claude" color="#c96442" size={18} />}
                  {k.id !== 'claude' && <AgentMark provider="codex" color="#0f8f6f" size={18} />}
                </span>
                <b>{k.label}</b>
                <small>{k.hint}</small>
              </button>
            ))}
          </div>

          <h3>Folder</h3>
          <div className="folder-pick">
            <div className="folder-current" title={folder}>
              <Icon name="folder" size={14} /> {folder ?? 'No folder chosen'}
            </div>
            <button className="btn" onClick={() => void browse()}>
              Choose…
            </button>
          </div>
          {recent.length > 0 && (
            <div className="recent-chips">
              {recent.slice(0, 8).map((f) => (
                <button key={f} className={`chip ${f === folder ? 'on' : ''}`} onClick={() => setFolder(f)} title={f}>
                  {basename(f)}
                </button>
              ))}
            </div>
          )}

          <h3>
            {kind === 'team' ? 'Agents' : 'Account'}
            <button className="btn tiny" onClick={() => openSettings('accounts')}>
              <Icon name="plus" size={11} /> Add account
            </button>
          </h3>
          <div className="account-options">
            {list.map((a) => (
              <AccountOption
                key={a.id}
                account={a}
                multi={kind === 'team'}
                checked={picked.includes(a.id)}
                onChange={(on) =>
                  setPicked((cur) => (kind === 'team' ? (on ? [...cur, a.id] : cur.filter((x) => x !== a.id)) : on ? [a.id] : cur))
                }
              />
            ))}
            {!list.length && <div className="panel-empty">No {kind === 'codex' ? 'ChatGPT' : 'Claude'} account yet. Add one first.</div>}
          </div>

          {kind === 'team' && (
            <label className="switch-row isolation">
              <input type="checkbox" checked={isolation} onChange={(e) => setIsolation(e.target.checked)} />
              <span>
                Give each agent its own copy of the project
                <small>
                  Each agent works in its own git worktree on its own branch, so they can't overwrite each other. You review and merge
                  each copy from the Changes panel. Needs a git repository with at least one commit.
                </small>
              </span>
            </label>
          )}

          <div className="modal-actions">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={!folder || !picked.length || creating} onClick={() => void create()}>
              {creating ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
