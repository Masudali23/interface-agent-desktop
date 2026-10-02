import { useEffect, useState } from 'react'
import { PROVIDER_LABEL, type Account, type RoomKind } from '@shared/types'
import { accountProblem, basename } from '../lib/format'
import { useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

const KINDS: Array<{ id: RoomKind; label: string; hint: string }> = [
  { id: 'claude', label: 'Claude Code', hint: 'One Claude Code agent, exactly like Claude desktop' },
  { id: 'codex', label: 'Codex', hint: 'One Codex agent, exactly like the Codex app' },
  { id: 'team', label: 'Team', hint: 'Several agents, any accounts, one shared conversation' }
]

function AccountOption({ account, checked, multi, onChange }: { account: Account; checked: boolean; multi: boolean; onChange: (on: boolean) => void }) {
  const info = useApp((s) => s.accountInfo[account.id])
  const problem = accountProblem(info)
  return (
    <label className={`account-option ${checked ? 'on' : ''} ${problem ? 'has-problem' : ''}`}>
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
        {problem && (
          <span className="ao-problem">
            <Icon name="alert" size={11} /> {problem}
          </span>
        )}
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
  const [error, setError] = useState<string>()
  const accountInfo = useApp((s) => s.accountInfo)

  useEffect(() => {
    if (!request) return
    setKind(request.kind)
    setFolder(request.folder ?? recent[0])
    setIsolation(false)
    setError(undefined)
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

  const browse = async (): Promise<string | undefined> => {
    const dir = await window.iface.pickFolder()
    if (dir) {
      setFolder(dir)
      setError(undefined)
    }
    return dir ?? undefined
  }

  // Start is never a dead button: it says what is missing, or asks for the folder.
  const create = async (): Promise<void> => {
    if (creating) return
    if (!picked.length) {
      setError(list.length ? 'Tick at least one account.' : 'Add an account first.')
      return
    }
    const dir = folder ?? (await browse())
    if (!dir) {
      setError('Choose the project folder the agents will work in.')
      return
    }
    setError(undefined)
    setCreating(true)
    try {
      const room = await window.iface.createRoom({ folder: dir, kind, accountIds: picked, isolation })
      close()
      await openRoom(room.id)
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method 'api': (Error: )?/, ''))
    } finally {
      setCreating(false)
    }
  }

  const blocked = picked.map((id) => accounts.find((a) => a.id === id)).filter((a) => a && accountProblem(accountInfo[a.id])) as Account[]

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
              <Icon name="folder" size={14} /> {folder ?? 'No folder chosen yet'}
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
            <button
              className="btn tiny"
              onClick={() => {
                // Settings opens on top; this dialog would otherwise hide it.
                close()
                openSettings('accounts')
              }}
            >
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

          {blocked.length > 0 && (
            <div className="form-warn">
              <Icon name="alert" size={13} />
              <span>
                {blocked.map((a) => a.name).join(', ')} can't work right now (see above). You can still start; {blocked.length === 1 ? 'it' : 'they'} will
                reply with an error until fixed.
              </span>
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={creating} onClick={() => void create()}>
              {creating ? 'Starting…' : folder ? 'Start session' : 'Choose folder and start'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
